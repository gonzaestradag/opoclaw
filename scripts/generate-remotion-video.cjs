#!/usr/bin/env node
/**
 * generate-remotion-video.cjs
 * Render a Remotion composition and send it to Telegram.
 * Usage: node generate-remotion-video.cjs <compositionId> <outputPath> [propsJson] [--send]
 *
 * Compositions available:
 *   - DataVideo (1920x1080 landscape)
 *   - DataVideoPortrait (1080x1920 portrait)
 *   - TradingReport (1920x1080)
 *   - Announcement (1080x1920 portrait)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const compositionId = process.argv[2] || 'DataVideo';
const outputPath = process.argv[3] || '/tmp/remotion-output.mp4';
const propsRaw = process.argv[4] || '{}';
const shouldSend = process.argv.includes('--send');

let props;
try {
  props = JSON.parse(propsRaw);
} catch (e) {
  props = {};
}

const remotionDir = '/Users/opoclaw1/claudeclaw/remotion';
const propsFile = `/tmp/remotion-props-${Date.now()}.json`;
fs.writeFileSync(propsFile, JSON.stringify(props));

console.log(`Rendering Remotion composition: ${compositionId}`);
console.log(`Props: ${JSON.stringify(props)}`);
console.log(`Output: ${outputPath}`);

try {
  const cmd = `cd "${remotionDir}" && npx remotion render src/index.ts ${compositionId} "${outputPath}" --props="${propsFile}"`;
  console.log('Running:', cmd);
  execSync(cmd, { stdio: 'inherit', timeout: 300000 });
  console.log('Render complete:', outputPath);

  // Clean up props file
  try { fs.unlinkSync(propsFile); } catch (_) {}

  // Send to Telegram if requested
  if (shouldSend) {
    const envContent = fs.readFileSync('/Users/opoclaw1/claudeclaw/.env', 'utf8');
    const botToken = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]?.trim();
    const chatId = envContent.match(/ALLOWED_CHAT_ID=(.+)/)?.[1]?.trim() ||
                   envContent.match(/TELEGRAM_CHAT_ID=(.+)/)?.[1]?.trim();

    if (botToken && chatId) {
      execSync(
        `curl -s -F "chat_id=${chatId}" -F "video=@${outputPath}" -F "caption=Video generado con Remotion — ${compositionId}" "https://api.telegram.org/bot${botToken}/sendVideo"`,
        { stdio: 'inherit' }
      );
      console.log('Sent to Telegram');
    } else {
      console.warn('Could not find TELEGRAM_BOT_TOKEN or chat ID in .env — video not sent');
    }
  }
} catch (e) {
  console.error('Render failed:', e.message);
  // Clean up props file on failure too
  try { fs.unlinkSync(propsFile); } catch (_) {}
  process.exit(1);
}
