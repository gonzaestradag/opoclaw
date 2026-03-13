import fs from 'fs';
import http from 'http';
import path from 'path';
import { execSync } from 'child_process';

import { createBot, injectMessage, thornAckResolvers, thornInputMode } from './bot.js';
import { ALLOWED_CHAT_ID, BOT_INJECT_PORT, TELEGRAM_BOT_TOKEN, STORE_DIR, PROJECT_ROOT } from './config.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';
import { cleanupOldUploads } from './media.js';
import { initDecaySweep } from './memory.js';
import { initScheduler } from './scheduler.js';

const PID_FILE = path.join(STORE_DIR, 'opoclaw.pid');

// ── TTS CLI subcommand ───────────────────────────────────────────────────────
// Usage: node dist/index.js tts "text to speak"
// Synthesizes speech via ElevenLabs and sends it as a Telegram voice note.
// Falls back to tg-notify.sh (text message) if TTS fails.
// Falls back to logging an error if tg-notify.sh also fails.
async function runTtsCli(text: string): Promise<void> {
  const { synthesizeSpeech, voiceCapabilities } = await import('./voice.js');
  const caps = voiceCapabilities();

  const sendFallbackText = (msg: string) => {
    try {
      const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'tg-notify.sh');
      execSync(`bash "${scriptPath}" "${msg.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
    } catch (fallbackErr) {
      // Both TTS and text fallback failed — log to stderr so PM2 captures it
      console.error('[tts-cli] All delivery methods failed:', fallbackErr);
    }
  };

  if (!caps.tts || !TELEGRAM_BOT_TOKEN || !ALLOWED_CHAT_ID) {
    // TTS not configured — send as text
    sendFallbackText(text);
    return;
  }

  try {
    const audioBuffer = await synthesizeSpeech(text);

    // Write audio to a temp file and send via Telegram sendVoice
    const tmpPath = path.join(STORE_DIR, `tts_${Date.now()}.mp3`);
    fs.writeFileSync(tmpPath, audioBuffer);

    try {
      const { InputFile } = await import('grammy');
      const { Bot } = await import('grammy');
      const tgBot = new Bot(TELEGRAM_BOT_TOKEN);
      await tgBot.api.sendVoice(ALLOWED_CHAT_ID, new InputFile(tmpPath, 'response.mp3'));

      // Signal to bot.ts that TTS was already sent during this agent run.
      // bot.ts reads this flag and suppresses its own synthesizeSpeech call to prevent
      // duplicate audio messages when Thorn calls `node dist/index.js tts` as a tool
      // AND also returns non-empty result.text that bot.ts would TTS-convert.
      try { fs.writeFileSync(`/tmp/opoclaw_tts_sent_${ALLOWED_CHAT_ID}`, '1'); } catch { /* ignore */ }
      // Also signal via HTTP to immediately stop Thorn's typing indicator (for voice delegations).
      const injectPort = process.env.BOT_INJECT_PORT || '3142';
      try {
        await fetch(`http://127.0.0.1:${injectPort}/thorn-ack/${ALLOWED_CHAT_ID}`, { method: 'POST' });
      } catch { /* non-fatal */ }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (ttsErr) {
    console.error('[tts-cli] TTS failed, falling back to text:', ttsErr);
    sendFallbackText(text);
  }
}

function showBanner(): void {
  const bannerPath = path.join(PROJECT_ROOT, 'banner.txt');
  try {
    const banner = fs.readFileSync(bannerPath, 'utf-8');
    console.log('\n' + banner);
  } catch {
    console.log('\n  OpoClaw\n');
  }
}

function acquireLock(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  // Just record our PID. launchd manages the process lifecycle — we don't kill
  // the old process here because doing so drops any in-flight agent queries.
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function main(): Promise<void> {
  showBanner();

  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is not set. Add it to .env and restart.');
    process.exit(1);
  }

  acquireLock();

  initDatabase();
  logger.info('Database ready');

  initDecaySweep();

  cleanupOldUploads();

  const bot = createBot();

  if (ALLOWED_CHAT_ID) {
    initScheduler(
      (text) => bot.api.sendMessage(ALLOWED_CHAT_ID, text, { parse_mode: 'HTML' }).then(() => {}),
      async (filePath, caption) => {
        const { InputFile } = await import('grammy');
        const { createReadStream } = await import('fs');
        await bot.api.sendDocument(
          ALLOWED_CHAT_ID,
          new InputFile(createReadStream(filePath), filePath.split('/').pop() ?? 'file'),
          caption ? { caption } : undefined
        );
      }
    );
  }

  // ── Inject server — inter-process IPC (dashboard-server → thorn-bot) ──────
  // Listens on 127.0.0.1 only. The dashboard-server POSTs here when a call
  // ends so the transcript is processed through the real Thorn pipeline instead
  // of going directly to GPT-4o-mini.
  const injectServer = http.createServer((req, res) => {
    // POST /inject — process a transcript through Thorn
    if (req.method === 'POST' && req.url === '/inject') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(202).end('accepted');
        try {
          const payload = JSON.parse(body) as { message?: string; voice?: boolean };
          const msg = payload.message ?? '';
          const voice = payload.voice ?? false;
          if (msg) {
            injectMessage(msg, voice).catch((err) => {
              logger.error({ err }, '[inject-server] injectMessage failed');
            });
          }
        } catch (parseErr) {
          logger.warn({ err: parseErr }, '[inject-server] Bad JSON payload');
        }
      });
      return;
    }

    // POST /thorn-ack/:chatId — called by tg-notify.sh to immediately stop Thorn's typing.
    // tg-notify.sh fires this as soon as it sends the delegation ack to Gonzalo,
    // allowing bot.ts to resolve earlyExitPromise and free Thorn from the handler.
    const ackMatch = req.method === 'POST' && req.url?.match(/^\/thorn-ack\/(.+)$/);
    if (ackMatch) {
      const chatId = ackMatch[1];
      const resolve = thornAckResolvers.get(chatId);
      if (resolve) resolve(); // immediately stops typing + triggers early exit
      res.writeHead(200).end('ok');
      return;
    }

    // POST /thorn-notify/:chatId — smart notification endpoint.
    // tg-notify.sh posts the message text here. The server checks whether the original
    // input was voice or text and delivers accordingly: TTS audio for voice, text for text.
    // This ensures agents don't need to know the input modality — the system handles it.
    const notifyMatch = req.method === 'POST' && req.url?.match(/^\/thorn-notify\/(.+)$/);
    if (notifyMatch) {
      const chatId = notifyMatch[1];
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(202).end('accepted');
        let messageText = '';
        try { messageText = (JSON.parse(body) as { text?: string }).text ?? ''; } catch { messageText = body.trim(); }
        if (!messageText) return;

        const isVoice = thornInputMode.get(chatId) ?? false;
        // Also fire the ack resolver so Thorn stops typing immediately
        thornAckResolvers.get(chatId)?.();

        void (async () => {
          try {
            if (isVoice) {
              const { synthesizeSpeech, voiceCapabilities } = await import('./voice.js');
              const { Bot, InputFile } = await import('grammy');
              if (voiceCapabilities().tts) {
                const audioBuffer = await synthesizeSpeech(messageText);
                const tmpPath = path.join(STORE_DIR, `notify_${Date.now()}.mp3`);
                fs.writeFileSync(tmpPath, audioBuffer);
                const notifyBot = new Bot(TELEGRAM_BOT_TOKEN!);
                await notifyBot.api.sendVoice(Number(chatId), new InputFile(tmpPath));
                fs.unlinkSync(tmpPath);
                return;
              }
            }
            // Text fallback (or non-voice input)
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: messageText, parse_mode: 'HTML' }),
            });
          } catch (notifyErr) {
            logger.error({ err: notifyErr }, '[thorn-notify] delivery failed');
          }
        })();
      });
      return;
    }

    res.writeHead(404).end();
  });
  injectServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Port already in use — another thorn-bot instance is likely still running.
      // Log and continue without the inject server rather than crashing and
      // triggering an endless PM2 restart loop.
      logger.warn({ port: BOT_INJECT_PORT }, '[inject-server] Port in use — inject endpoint unavailable. Check for stale processes.');
    } else {
      logger.error({ err }, '[inject-server] Server error');
    }
  });
  injectServer.listen(BOT_INJECT_PORT, '127.0.0.1', () => {
    logger.info({ port: BOT_INJECT_PORT }, '[inject-server] Listening for call transcript injections');
  });

  const shutdown = async () => {
    logger.info('Shutting down...');
    releaseLock();
    injectServer.close();
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.info('Starting OpoClaw...');

  await bot.start({
    drop_pending_updates: true,
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, 'OpoClaw is running');
      console.log(`\n  OpoClaw online: @${botInfo.username}`);
      console.log(`  Send /chatid to get your chat ID for ALLOWED_CHAT_ID\n`);
    },
  });
}

// ── CLI dispatch ─────────────────────────────────────────────────────────────
const subcommand = process.argv[2];

if (subcommand === 'tts') {
  const ttsText = process.argv.slice(3).join(' ').trim();
  if (!ttsText) {
    console.error('[tts-cli] Usage: node dist/index.js tts "text to speak"');
    process.exit(1);
  }
  runTtsCli(ttsText).then(() => process.exit(0)).catch((err) => {
    console.error('[tts-cli] Fatal:', err);
    process.exit(1);
  });
} else {
  main().catch((err: unknown) => {
    logger.error({ err }, 'Fatal error');
    releaseLock();
    process.exit(1);
  });
}
