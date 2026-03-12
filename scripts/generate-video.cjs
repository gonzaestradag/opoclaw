#!/usr/bin/env node
/**
 * generate-video.cjs
 * Generate a talking-head video of Thorn speaking a given script.
 * Uses: ElevenLabs (cloned voice) + HeyGen Photo Avatar (Thorn's photo)
 *
 * Usage:
 *   node scripts/generate-video.cjs "Script text here" [title] [output_path]
 *
 * Or from stdin:
 *   echo "Script text" | node scripts/generate-video.cjs
 *
 * Examples:
 *   node scripts/generate-video.cjs "Today the market moved 3% upward..."
 *   node scripts/generate-video.cjs "Full report text here" "Trading Report Mar 12" /tmp/report.mp4
 *
 * Outputs: sends the MP4 video to Telegram and prints the file path.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── Config ──────────────────────────────────────────────────────────────────
const ENV_FILE = path.join(__dirname, '../.env');

function readEnv() {
  const env = {};
  fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
  return env;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsPost(hostname, path_, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    const opts = {
      hostname, path: path_, method: 'POST',
      headers: { 'Content-Length': buf.length, ...headers },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Generate audio with ElevenLabs ───────────────────────────────────
async function generateAudio(text, apiKey, voiceId) {
  console.log('[1/4] Generating audio with ElevenLabs...');

  const payload = JSON.stringify({
    text,
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.85, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true },
  });

  const res = await httpsPost(
    'api.elevenlabs.io',
    `/v1/text-to-speech/${voiceId}`,
    {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    payload
  );

  if (res.status !== 200) {
    throw new Error(`ElevenLabs error ${res.status}: ${res.body.toString()}`);
  }

  const audioPath = `/tmp/thorn_video_audio_${Date.now()}.mp3`;
  fs.writeFileSync(audioPath, res.body);
  console.log(`    Audio saved (${Math.round(res.body.length / 1024)} KB)`);
  return audioPath;
}

// ── Step 2: Upload audio to HeyGen assets ───────────────────────────────────
async function uploadAudioToHeyGen(audioPath, apiKey) {
  console.log('[2/4] Uploading audio to HeyGen...');

  // HeyGen requires raw binary POST with Content-Type: audio/mpeg
  const fileBuffer = fs.readFileSync(audioPath);

  const res = await httpsPost(
    'upload.heygen.com',
    '/v1/asset',
    {
      'X-Api-Key': apiKey,
      'Content-Type': 'audio/mpeg',
    },
    fileBuffer
  );

  const json = JSON.parse(res.body.toString());
  if (res.status !== 200 || !json?.data?.url) {
    throw new Error(`HeyGen asset upload error ${res.status}: ${res.body.toString()}`);
  }

  const audioUrl = json.data.url;
  console.log('    Audio URL obtained');
  return audioUrl;
}

// ── Step 3: Create HeyGen video ──────────────────────────────────────────────
async function createHeyGenVideo(audioUrl, avatarId, title, apiKey, format) {
  console.log('[3/4] Creating HeyGen video...');

  // format: 'portrait' = 720x1280 (reel/stories), 'landscape' = 1280x720 (desktop), 'square' = 1080x1080
  const dimensions = {
    portrait:  { width: 720,  height: 1280 },
    landscape: { width: 1280, height: 720  },
    square:    { width: 1080, height: 1080 },
  };
  const dim = dimensions[format] || dimensions.landscape;
  console.log(`    Format: ${format || 'landscape'} (${dim.width}x${dim.height})`);

  const payload = JSON.stringify({
    title: title || 'Thorn Report',
    video_inputs: [{
      character: {
        type: 'talking_photo',
        talking_photo_id: avatarId,
      },
      voice: {
        type: 'audio',
        audio_url: audioUrl,
      },
      background: {
        type: 'color',
        value: '#0a0e1a',
      },
    }],
    dimension: dim,
    test: false,
  });

  const res = await httpsPost(
    'api.heygen.com',
    '/v2/video/generate',
    {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    payload
  );

  const json = JSON.parse(res.body.toString());
  if (res.status !== 200 || !json?.data?.video_id) {
    throw new Error(`HeyGen video create error ${res.status}: ${res.body.toString()}`);
  }

  const videoId = json.data.video_id;
  console.log('    Video ID:', videoId);
  return videoId;
}

// ── Step 4: Poll until ready ──────────────────────────────────────────────────
async function pollVideoReady(videoId, apiKey) {
  console.log('[4/4] Waiting for video to render (~5-10 min)...');
  const maxWait = 20 * 60 * 1000; // 20 minutes max
  const start   = Date.now();
  let dots = 0;

  while (Date.now() - start < maxWait) {
    await sleep(30000); // poll every 30 seconds
    dots++;
    process.stdout.write(`    Polling... ${dots * 30}s elapsed\r`);

    const res = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'api.heygen.com',
        path: `/v1/video_status.get?video_id=${videoId}`,
        headers: { 'X-Api-Key': apiKey },
      }, r => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      }).on('error', reject);
    });

    const status = res?.data?.status;

    if (status === 'completed') {
      console.log('\n    Video ready!');
      return res.data.video_url;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`HeyGen video failed: ${JSON.stringify(res.data)}`);
    }
  }

  throw new Error('HeyGen video timed out after 20 minutes');
}

// ── Step 5: Download video ────────────────────────────────────────────────────
async function downloadVideo(videoUrl, outputPath) {
  const res = await httpsGet(videoUrl);
  if (res.status !== 200) throw new Error(`Download failed: ${res.status}`);
  fs.writeFileSync(outputPath, res.body);
  console.log(`    Video saved: ${outputPath} (${Math.round(res.body.length / 1024 / 1024 * 10) / 10} MB)`);
  return outputPath;
}

// ── Step 6: Send video to Telegram ────────────────────────────────────────────
async function sendVideoToTelegram(videoPath, caption, botToken, chatId) {
  const fileBuffer = fs.readFileSync(videoPath);
  const boundary   = '----TelegramBoundary' + Date.now().toString(36);
  const CRLF       = '\r\n';

  const captionPart = Buffer.from([
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="caption"${CRLF}`,
    CRLF,
    caption,
    CRLF,
  ].join(''));

  const chatPart = Buffer.from([
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="chat_id"${CRLF}`,
    CRLF,
    chatId,
    CRLF,
  ].join(''));

  const videoPart = Buffer.from([
    `--${boundary}${CRLF}`,
    `Content-Disposition: form-data; name="video"; filename="${path.basename(videoPath)}"${CRLF}`,
    `Content-Type: video/mp4${CRLF}`,
    CRLF,
  ].join(''));

  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([chatPart, captionPart, videoPart, fileBuffer, epilogue]);

  const res = await httpsPost(
    'api.telegram.org',
    `/bot${botToken}/sendVideo`,
    { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  );

  const json = JSON.parse(res.body.toString());
  if (!json.ok) throw new Error(`Telegram sendVideo error: ${JSON.stringify(json)}`);
  console.log('    Video sent to Telegram.');
}

// ── Log activity to dashboard ─────────────────────────────────────────────────
function logActivity(message) {
  try {
    const { execSync } = require('child_process');
    execSync(`curl -s -X POST http://localhost:3001/api/agent-messages \
      -H "Content-Type: application/json" \
      -d '{"thread_id":"video-gen","from_agent_id":"thorn","from_agent_name":"Thorn","from_agent_emoji":"🌵","message":"${message.replace(/'/g, '')}","message_type":"message"}' > /dev/null 2>&1`);
  } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const env = readEnv();

  const elevenKey   = env.ELEVENLABS_API_KEY;
  const elevenVoice = env.ELEVENLABS_VOICE_ID;
  const heygenKey   = env.HEYGEN_API_KEY;
  const avatarId    = env.HEYGEN_THORN_AVATAR_ID;
  const botToken    = env.TELEGRAM_BOT_TOKEN;
  const chatId      = env.ALLOWED_CHAT_ID || env.TELEGRAM_CHAT_ID;

  // Validate required config
  const missing = [];
  if (!elevenKey)   missing.push('ELEVENLABS_API_KEY');
  if (!elevenVoice) missing.push('ELEVENLABS_VOICE_ID');
  if (!heygenKey)   missing.push('HEYGEN_API_KEY');
  if (!avatarId)    missing.push('HEYGEN_THORN_AVATAR_ID (run: node scripts/setup-heygen-avatar.cjs)');
  if (!botToken)    missing.push('TELEGRAM_BOT_TOKEN');
  if (!chatId)      missing.push('ALLOWED_CHAT_ID');

  if (missing.length > 0) {
    console.error('Missing required env vars:');
    missing.forEach(v => console.error(' -', v));
    process.exit(1);
  }

  // Get script text from args or stdin
  let scriptText = process.argv[2];
  const title    = process.argv[3] || 'Thorn — Video Report';
  const outPath  = process.argv[4] || `/tmp/thorn_video_${Date.now()}.mp4`;
  // format: 'portrait' | 'landscape' | 'square' (default: landscape)
  const format   = process.argv[5] || 'landscape';

  if (!scriptText) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    scriptText = Buffer.concat(chunks).toString().trim();
  }

  if (!scriptText) {
    console.error('Usage: node generate-video.cjs "Script text" [title] [output_path]');
    process.exit(1);
  }

  console.log('\nGenerating Thorn video...');
  console.log('Title:', title);
  console.log('Script length:', scriptText.length, 'chars\n');

  logActivity('Iniciando generacion de video con HeyGen + ElevenLabs');

  const audioPath = await generateAudio(scriptText, elevenKey, elevenVoice);
  const audioUrl  = await uploadAudioToHeyGen(audioPath, heygenKey);
  const videoId   = await createHeyGenVideo(audioUrl, avatarId, title, heygenKey, format);

  logActivity(`Video en render — ID: ${videoId}`);

  const videoUrl  = await pollVideoReady(videoId, heygenKey);
  const videoPath = await downloadVideo(videoUrl, outPath);

  const caption = `${title}\n\nGenerado por Thorn via HeyGen + ElevenLabs`;
  await sendVideoToTelegram(videoPath, caption, botToken, chatId);

  logActivity(`Video listo y enviado: ${title}`);

  // Cleanup temp audio
  fs.unlink(audioPath, () => {});

  console.log('\nDone. Video path:', videoPath);
  process.exit(0);
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
