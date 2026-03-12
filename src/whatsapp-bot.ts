/**
 * whatsapp-bot.ts — Standalone WhatsApp process for PM2
 *
 * Runs independently of thorn-bot. Initializes the WhatsApp Web client,
 * holds the session, and notifies Gonzalo via Telegram when messages arrive.
 * The thorn-bot reads messages on demand via /wa.
 */

import { Bot } from 'grammy';

import { ALLOWED_CHAT_ID, TELEGRAM_BOT_TOKEN, WHATSAPP_ENABLED } from './config.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';
import { initWhatsApp } from './whatsapp.js';

if (!WHATSAPP_ENABLED) {
  logger.warn('WHATSAPP_ENABLED is not true — exiting whatsapp-bot.');
  process.exit(0);
}

if (!TELEGRAM_BOT_TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN is not set — exiting whatsapp-bot.');
  process.exit(1);
}

if (!ALLOWED_CHAT_ID) {
  logger.error('ALLOWED_CHAT_ID is not set — exiting whatsapp-bot.');
  process.exit(1);
}

// Minimal Telegram bot instance just for sending notifications
const tg = new Bot(TELEGRAM_BOT_TOKEN);

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTgNotification(contactName: string, isGroup: boolean, groupName?: string): Promise<void> {
  const origin = isGroup && groupName ? groupName : contactName;
  const text = `📱 <b>${escapeHtml(origin)}</b> — new message\n<i>/wa to view &amp; reply</i>`;
  try {
    await tg.api.sendMessage(parseInt(ALLOWED_CHAT_ID, 10), text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ err }, '[whatsapp-bot] Failed to send Telegram notification');
  }
}

async function main(): Promise<void> {
  logger.info('[whatsapp-bot] Starting WhatsApp process...');

  // DB must be initialized before WhatsApp (saveWaMessage depends on it)
  initDatabase();

  await initWhatsApp(sendTgNotification);

  logger.info('[whatsapp-bot] WhatsApp initialized and running.');
}

const shutdown = () => {
  logger.info('[whatsapp-bot] Shutting down...');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err: unknown) => {
  logger.error({ err }, '[whatsapp-bot] Fatal error');
  process.exit(1);
});
