import fs, { mkdirSync } from 'fs';
import https from 'https';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';

// ── Upload directory ────────────────────────────────────────────────────────

export const UPLOADS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'workspace',
  'uploads',
);

mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Make an HTTPS request and return the response body as a Buffer.
 */
function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: Buffer | string,
  timeoutMs = 30000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`httpsRequest timed out after ${timeoutMs}ms: ${url}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Convenience wrapper for HTTPS GET that returns a Buffer.
 */
function httpsGet(url: string, timeoutMs = 20000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl: string, redirected = false) => {
      const req = https.get(targetUrl, (res) => {
        // Follow a single redirect if present
        if (
          !redirected &&
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.destroy(); // Release socket before following redirect
          doGet(res.headers.location, true);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`));
            return;
          }
          resolve(buf);
        });
        res.on('error', reject);
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${targetUrl}`));
      });
      req.on('error', reject);
    };
    doGet(url);
  });
}

// ── STT: Groq Whisper ───────────────────────────────────────────────────────

/**
 * Download a Telegram file to a local temp path and return the path.
 * Uses the Telegram Bot API file download endpoint.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  destDir: string,
): Promise<string> {
  mkdirSync(destDir, { recursive: true });

  // Step 1: Get the file path from Telegram
  const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const infoBuffer = await httpsGet(infoUrl);
  const info = JSON.parse(infoBuffer.toString('utf-8')) as {
    ok: boolean;
    result?: { file_path?: string };
  };

  if (!info.ok || !info.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${infoBuffer.toString('utf-8').slice(0, 300)}`);
  }

  // Step 2: Download the actual file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`;
  const fileBuffer = await httpsGet(downloadUrl);

  // Step 3: Save locally
  // Telegram sends voice as .oga — Groq requires .ogg. Rename transparently.
  const rawExt = path.extname(info.result.file_path) || '.ogg';
  const ext = rawExt === '.oga' ? '.ogg' : rawExt;
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const localPath = path.join(destDir, filename);
  fs.writeFileSync(localPath, fileBuffer);

  return localPath;
}

/**
 * Transcribe an audio file using Groq's Whisper API.
 * Supports .ogg, .mp3, .wav, .m4a.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const env = readEnvFile(['GROQ_API_KEY']);
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not set in .env');
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;

  // Build multipart/form-data body manually
  const parts: Buffer[] = [];

  // File field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: audio/ogg\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n'));

  // Model field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `whisper-large-v3\r\n`,
    ),
  );

  // Response format field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`,
    ),
  );

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const responseBuffer = await httpsRequest(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length.toString(),
      },
    },
    body,
  );

  const response = JSON.parse(responseBuffer.toString('utf-8')) as {
    text?: string;
  };

  return response.text ?? '';
}

// ── TTS: ElevenLabs ─────────────────────────────────────────────────────────

// ElevenLabs enforces a per-request character limit. 2500 is safe across all plans.
const TTS_MAX_CHARS = 2500;

// Retry config: up to 3 attempts, delays 1s → 3s → 9s (exponential)
const TTS_MAX_ATTEMPTS = 3;
const TTS_RETRY_BASE_MS = 1000;

/**
 * Determine whether an HTTP error status is worth retrying.
 * 429 (rate limit) and 5xx (server errors) are retryable.
 * 4xx (except 429) are permanent failures — don't retry.
 */
function isTtsRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

/**
 * Convert text to speech using ElevenLabs and return the audio as a Buffer.
 * Uses the voice ID from ELEVENLABS_VOICE_ID in .env.
 *
 * Improvements over the original:
 * - Truncates text to TTS_MAX_CHARS to stay within ElevenLabs limits.
 * - Retries up to TTS_MAX_ATTEMPTS times with exponential backoff on transient errors
 *   (rate limits, server errors, network failures).
 * - Fails fast on permanent errors (bad API key, invalid voice ID, etc.).
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const env = readEnvFile(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
  const apiKey = env.ELEVENLABS_API_KEY;
  const voiceId = env.ELEVENLABS_VOICE_ID;

  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not set in .env');
  }
  if (!voiceId) {
    throw new Error('ELEVENLABS_VOICE_ID not set in .env');
  }

  // Truncate to stay within ElevenLabs character limit.
  // If truncated, end on the last sentence boundary to avoid mid-sentence cut.
  let safeText = text.length > TTS_MAX_CHARS ? text.slice(0, TTS_MAX_CHARS) : text;
  if (text.length > TTS_MAX_CHARS) {
    const lastPeriod = Math.max(safeText.lastIndexOf('. '), safeText.lastIndexOf('.\n'));
    if (lastPeriod > TTS_MAX_CHARS / 2) {
      safeText = safeText.slice(0, lastPeriod + 1);
    }
  }

  const payload = JSON.stringify({
    text: safeText,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.90,       // Higher stability = consistent voice across long texts (ElevenLabs internal chunks)
      similarity_boost: 0.80, // Slightly lower to reduce artifacts on long-form synthesis
      style: 0.0,
      use_speaker_boost: true,
    },
  });

  let lastError: Error = new Error('TTS: no attempts made');

  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    try {
      const audioBuffer = await httpsRequest(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
            'Content-Length': Buffer.byteLength(payload).toString(),
          },
        },
        payload,
      );
      return audioBuffer;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if this is a permanent HTTP error (e.g. 401, 403, 400)
      const match = lastError.message.match(/^HTTP (\d+):/);
      if (match) {
        const status = parseInt(match[1]);
        if (!isTtsRetryableStatus(status)) {
          // Permanent error — fail immediately, no retry
          throw lastError;
        }
      }

      if (attempt < TTS_MAX_ATTEMPTS) {
        const delayMs = TTS_RETRY_BASE_MS * Math.pow(3, attempt - 1); // 1s, 3s, 9s
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

// ── Capabilities check ──────────────────────────────────────────────────────

/**
 * Check whether voice mode is available (all required env vars are set).
 */
export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  const env = readEnvFile([
    'GROQ_API_KEY',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
  ]);

  return {
    stt: !!env.GROQ_API_KEY,
    tts: !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID),
  };
}
