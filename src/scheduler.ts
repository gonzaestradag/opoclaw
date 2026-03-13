import fs from 'fs';

import { CronExpressionParser } from 'cron-parser';

import { ALLOWED_CHAT_ID } from './config.js';
import {
  getDueTasks,
  logAgentActivity,
  updateTaskAfterRun,
  updateTaskForRetry,
} from './db.js';
import { logger } from './logger.js';
import { runAgent } from './agent.js';
import { extractFileMarkers } from './bot.js';

// ── Retry configuration ──────────────────────────────────────────────────────
const MAX_RETRIES = 3;
// Delay in seconds for each retry attempt: 1min, 5min, 15min
const RETRY_DELAYS_SECS = [60, 300, 900];

type Sender = (text: string) => Promise<void>;
type FileSender = (filePath: string, caption?: string) => Promise<void>;

let sender: Sender;
let fileSender: FileSender;
let isRunning = false; // Guard against overlapping runs if tasks exceed 60s

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
export function initScheduler(send: Sender, sendFile?: FileSender): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  fileSender = sendFile ?? (async () => {});
  setInterval(() => void runDueTasks(), 60_000);
  logger.info('Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  if (isRunning) {
    logger.warn('Scheduler: previous run still in progress, skipping this tick');
    return;
  }
  isRunning = true;
  let tasks: ReturnType<typeof getDueTasks>;
  try {
    tasks = getDueTasks();
  } catch (err) {
    logger.error({ err }, 'Scheduler: failed to fetch due tasks — resetting lock');
    isRunning = false;
    return;
  }
  if (tasks.length === 0) {
    isRunning = false;
    return;
  }

  logger.info({ count: tasks.length }, 'Running due scheduled tasks');

  for (const task of tasks) {
    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    logAgentActivity(
      `Scheduled task started: ${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}`,
      'task',
    );

    try {
      // Clear any stale tg-notify flag before running the agent so we can detect
      // if tg-notify.sh was called during THIS task's execution.
      const tgNotifyFlagPath = ALLOWED_CHAT_ID ? `/tmp/opoclaw_tg_notify_sent_${ALLOWED_CHAT_ID}` : null;
      if (tgNotifyFlagPath) {
        try { fs.unlinkSync(tgNotifyFlagPath); } catch { /* may not exist */ }
      }

      // Run as a fresh agent call (no session — scheduled tasks are autonomous)
      const result = await runAgent(task.prompt, undefined, () => {});

      // Check if tg-notify.sh was called during agent execution.
      // If it was, the agent already sent a Telegram message (and possibly a file).
      // Sending [SEND_FILE:] markers on top of that would produce duplicate sends.
      const tgNotifyWasCalled = tgNotifyFlagPath
        ? (() => {
            try { fs.accessSync(tgNotifyFlagPath); fs.unlinkSync(tgNotifyFlagPath); return true; } catch { return false; }
          })()
        : false;

      // Only process [SEND_FILE:] markers if tg-notify.sh was NOT called during this run.
      // If tg-notify was called, the agent already handled its own file/message delivery.
      const rawText = tgNotifyWasCalled ? '' : (result.text?.trim() || '');
      const { text: cleanedText, files } = extractFileMarkers(rawText);

      // Send any files first (e.g. morning podcast audio)
      // Only reached when tgNotifyWasCalled is false (guard above ensures rawText is '' otherwise)
      for (const file of files) {
        try {
          await fileSender(file.filePath, file.caption);
        } catch (fileErr) {
          logger.error({ fileErr, filePath: file.filePath }, 'Failed to send scheduled task file');
        }
      }

      // Scheduled tasks notify via tg-notify.sh in their scripts — never send agent text output
      const text = cleanedText || '';

      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, nextRun, text);

      logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      logger.error({ err, taskId: task.id }, 'Scheduled task failed');

      const currentRetryCount = task.retry_count ?? 0;

      if (currentRetryCount < MAX_RETRIES) {
        // Schedule a retry with exponential backoff
        const delaySecs = RETRY_DELAYS_SECS[currentRetryCount] ?? RETRY_DELAYS_SECS[RETRY_DELAYS_SECS.length - 1];
        const nextRetryCount = currentRetryCount + 1;
        try {
          updateTaskForRetry(task.id, delaySecs, nextRetryCount, errMsg);
          logger.info(
            { taskId: task.id, attempt: nextRetryCount, retryInSecs: delaySecs },
            `Task failed — retry ${nextRetryCount}/${MAX_RETRIES} in ${delaySecs}s`,
          );
          logAgentActivity(
            `Scheduled task retry ${nextRetryCount}/${MAX_RETRIES} in ${Math.round(delaySecs / 60)}min: ${task.prompt.slice(0, 60)}`,
            'warning',
          );
        } catch {
          // ignore — logged above
        }
      } else {
        // Max retries exhausted — advance to next scheduled run and reset counter
        logger.warn(
          { taskId: task.id, maxRetries: MAX_RETRIES },
          'Scheduled task exhausted all retries — advancing to next cron slot',
        );
        try {
          const nextRun = computeNextRun(task.schedule);
          updateTaskAfterRun(task.id, nextRun, `ERROR (gave up after ${MAX_RETRIES} retries): ${errMsg}`);
        } catch {
          // ignore
        }
        try {
          await sender(
            `Task failed after ${MAX_RETRIES} retries: "${task.prompt.slice(0, 60)}..." — check logs.`,
          );
        } catch {
          // ignore send failure
        }
        logAgentActivity(
          `Scheduled task failed after ${MAX_RETRIES} retries: ${task.prompt.slice(0, 60)}`,
          'error',
        );
      }
    }
  }
  isRunning = false;
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
