#!/usr/bin/env node
// trading-watchdog.js — Node.js wrapper for PM2 cron compatibility
// PM2 executes this every 2 minutes via cron restart
// It runs the bash watchdog script and exits cleanly

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT = '/Users/opoclaw1/claudeclaw/scripts/trading-watchdog.sh';
const LOG = '/Users/opoclaw1/claudeclaw/logs/trading-watchdog.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG, line);
  } catch (e) {
    // ignore log write errors
  }
}

log('PM2 watchdog tick — running trading-watchdog.sh');

try {
  const result = spawnSync('bash', [SCRIPT], {
    stdio: 'inherit',
    timeout: 60000, // 60 second timeout
    encoding: 'utf8'
  });

  if (result.error) {
    log(`Watchdog script error: ${result.error.message}`);
    process.exit(1);
  }

  log(`Watchdog script completed with exit code: ${result.status}`);
  process.exit(0);
} catch (err) {
  log(`Watchdog execution failed: ${err.message}`);
  process.exit(1);
}
