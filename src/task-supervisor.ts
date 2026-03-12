/**
 * task-supervisor.ts
 * ─────────────────────────────────────────────────────────────────
 * Executive supervisor — runs every 5 minutes, detects stuck or
 * failed tasks in agent_tasks and resets them for retry.
 *
 * PM2: pm2 start dist/task-supervisor.js --name task-supervisor
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '../store/opoclaw.db');
const API_URL   = 'http://localhost:3001';

const STUCK_THRESHOLD_MIN  = 25; // in_progress tasks older than this → reset
const ERROR_THRESHOLD_MIN  = 10; // error tasks older than this → reset
const POLL_MS              = 5 * 60 * 1000; // 5 minutes

const db = new Database(DB_PATH);

// ── helpers ──────────────────────────────────────────────────────

async function logActivity(action: string, type = 'info'): Promise<void> {
  try {
    await fetch(`${API_URL}/api/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id:    'argus',
        agent_name:  'Argus',
        agent_emoji: '👁️',
        action,
        type,
        department:  'executive',
      }),
    });
  } catch { /* non-fatal */ }
}

async function postMessage(threadId: string, message: string): Promise<void> {
  try {
    await fetch(`${API_URL}/api/agent-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id:        threadId,
        from_agent_id:    'argus',
        from_agent_name:  'Argus',
        from_agent_emoji: '👁️',
        message,
        message_type:     'message',
      }),
    });
  } catch { /* non-fatal */ }
}

// ── main tick ────────────────────────────────────────────────────

function tick(): void {
  const now = new Date().toISOString();
  console.log(`[argus] Tick — ${now}`);

  // 1. Stuck in_progress tasks
  const stuckInProgress = db.prepare(`
    SELECT id, title, assignee_id, assignee_name, retry_after
    FROM agent_tasks
    WHERE status = 'in_progress'
      AND skip_worker = 0
      AND (
        updated_at IS NULL
        OR (julianday('now') - julianday(updated_at)) * 1440 > ?
      )
  `).all(STUCK_THRESHOLD_MIN) as Array<{
    id: string; title: string; assignee_id: string; assignee_name: string; retry_after: string | null;
  }>;

  for (const task of stuckInProgress) {
    const currentRetries = task.retry_after ? parseInt(task.retry_after) || 0 : 0;
    const newRetries = currentRetries + 1;

    if (newRetries > 3) {
      // Give up after 3 retries — mark as error
      db.prepare(`UPDATE agent_tasks SET status = 'error', updated_at = datetime('now') WHERE id = ?`)
        .run(task.id);
      console.warn(`[argus] Task ${task.id} exceeded max retries — marked error: ${task.title}`);
      void logActivity(`Tarea sin resolver tras 3 intentos — marcada error: "${task.title}"`, 'warning');
      void postMessage(task.id, `Supervisor: tarea marcada como error tras 3 reintentos — "${task.title}"`);
    } else {
      db.prepare(`UPDATE agent_tasks SET status = 'todo', progress = 0, retry_after = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(String(newRetries), task.id);
      console.warn(`[argus] Reset stuck task ${task.id} (attempt ${newRetries}): ${task.title}`);
      void logActivity(`Tarea atascada reiniciada (intento ${newRetries}): "${task.title}"`, 'warning');
      void postMessage(task.id, `Supervisor: tarea reiniciada por inactividad (intento ${newRetries}) — "${task.title}"`);
    }
  }

  // 2. Error tasks older than threshold → retry
  const stuckErrors = db.prepare(`
    SELECT id, title, assignee_id, retry_after
    FROM agent_tasks
    WHERE status = 'error'
      AND skip_worker = 0
      AND (julianday('now') - julianday(updated_at)) * 1440 > ?
  `).all(ERROR_THRESHOLD_MIN) as Array<{
    id: string; title: string; assignee_id: string; retry_after: string | null;
  }>;

  for (const task of stuckErrors) {
    const currentRetries = task.retry_after ? parseInt(task.retry_after) || 0 : 0;
    if (currentRetries >= 3) continue; // already gave up

    db.prepare(`UPDATE agent_tasks SET status = 'todo', progress = 0, retry_after = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(String(currentRetries + 1), task.id);
    console.warn(`[argus] Reset errored task ${task.id}: ${task.title}`);
    void logActivity(`Tarea con error reiniciada: "${task.title}"`, 'info');
  }

  const total = stuckInProgress.length + stuckErrors.length;
  if (total === 0) {
    console.log(`[argus] All clear — no stuck tasks`);
  } else {
    console.log(`[argus] Reset ${total} task(s)`);
  }
}

// ── start ────────────────────────────────────────────────────────

console.log(`[argus] Starting — checking every ${POLL_MS / 60000} min`);
void logActivity('Argus en línea — monitoreando todas las tareas', 'success');

tick(); // run immediately on startup
setInterval(tick, POLL_MS);
