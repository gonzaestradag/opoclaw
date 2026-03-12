/**
 * agent-worker.ts
 * ─────────────────────────────────────────────────────────────────
 * Autonomous task executor for OpoClaw agents.
 *
 * Polls `agent_tasks` every POLL_INTERVAL_MS for tasks with status='todo'.
 * Picks the highest-priority one, marks it in_progress, runs the agent,
 * logs activity, and marks it done — all reflected live in the dashboard.
 *
 * Run via PM2: pm2 start dist/agent-worker.js --name agent-worker
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAgent } from './agent.js';

// PM2 inherits CLAUDECODE=1 from the shell that started it.
// The claude SDK refuses to spawn a subprocess if CLAUDECODE is set.
// Remove it so the agent-worker can launch agents freely.
delete process.env['CLAUDECODE'];
delete process.env['CLAUDE_CODE_ENTRYPOINT'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'store', 'claudeclaw.db');
const POLL_INTERVAL_MS = 2_000;    // check every 2s for fast task pickup
const MAX_CONCURRENT = 4;          // run up to 4 agents at once
const TASK_TIMEOUT_MS = 20 * 60 * 1000; // 20 min per task before forced failure
const ACTIVE_KEEPALIVE_MS = 90_000; // re-log activity every 90s to stay "active" in Team Status
/** Tasks in_progress longer than this (seconds) are considered stuck and reset. */
const STUCK_TASK_THRESHOLD_S = 15 * 60; // 15 minutes
/** Max automatic retries before a task is permanently marked failed. */
const MAX_RETRIES = 3;
/** Seconds to wait between automatic retries. */
const RETRY_DELAY_S = 30;

// ── Agent personas ──────────────────────────────────────────────────────────
const PERSONAS: Record<string, string> = {
  'thorn':         'Thorn, CEO & Asistente Personal de Gonzalo. Eres el director ejecutivo de OpoClaw.',
  'marcus-reyes':  'Marcus Reyes ⚙️, CTO de OpoClaw. Experto en arquitectura, código, infraestructura.',
  'lucas-park':    'Lucas Park 🎨, Frontend Engineer de OpoClaw. Experto en React, UI, Vite, Tailwind.',
  'elias-mora':    'Elias Mora 🔧, Backend & Infraestructura de OpoClaw. Experto en Node.js, SQLite, APIs.',
  'silas-vane':    'Silas Vane ⚡, DevOps & Automatización de OpoClaw. Experto en PM2, scripts, pipelines.',
  'rafael-silva':  'Dr. Rafael Silva 🔭, CRO de OpoClaw. Director de Inteligencia, análisis de mercado y AI.',
  'kaelen-ward':   'Kaelen Ward 🔍, Research Analyst de OpoClaw. Especialista en investigación y síntesis.',
  'maya-chen':     'Maya Chen 📋, COO y Chief of Staff de OpoClaw. Maneja operaciones y coordina el equipo.',
  'jordan-walsh':  'Jordan Walsh 💰, CFO de OpoClaw. Director de Finanzas y control de costos.',
  'sofia-ramos':   'Sofía Ramos ✍️, Directora de Contenido & Marca de OpoClaw.',
  'aria-nakamura':  'Aria Nakamura 🎯, CSO de OpoClaw. Directora de Estrategia.',
  'quinn-vale':     'Quinn Vale 🔧, Systems Reliability de OpoClaw. Monitor de errores, alertas y estabilidad del sistema.',
  'victoria-cross': 'Victoria Cross 🚀, Directora de Ventures de OpoClaw. Coordina y lidera el equipo de nuevas ventures.',
  'valentina-cruz': 'Valentina Cruz 🚀, Head of Ventures de OpoClaw. Lidera iniciativas de nuevos negocios y oportunidades.',
  'alex-hunt':      'Alex Hunt 🔍, Opportunity Scout de OpoClaw. Investiga oportunidades de mercado y nuevos negocios.',
  'daniel-moss':    'Daniel Moss 📊, Business Plan Analyst de OpoClaw. Elabora planes de negocio y análisis de viabilidad.',
  'nora-blake':     'Nora Blake 🎯, Pitch Designer de OpoClaw. Diseña pitch decks y materiales de presentación para ventures.',
  'owen-reeve':     'Owen Reeve 💻, Demo Builder de OpoClaw. Construye demos web y prototipos para nuevas ventures.',
  'sam-reed':       'Sam Reed 🤝, Commercial Strategist de OpoClaw. Define estrategia comercial y go-to-market.',
  'morgan-lane':    'Morgan Lane 📈, Financial Modeler de OpoClaw. Construye modelos financieros y proyecciones para ventures.',
  'camila-torres':  'Camila Torres 📋, Pitch & Docs de OpoClaw. Redacta documentos, pitches y materiales de ventures.',
  'diego-reyes':    'Diego Reyes 🤝, BD & Client Acquisition de OpoClaw. Lidera desarrollo de negocios y adquisición de clientes.',
};

// ── Priority order ──────────────────────────────────────────────────────────
const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

// ── Active task tracker ─────────────────────────────────────────────────────
const activeAgents = new Set<string>();

// ── DB helpers ──────────────────────────────────────────────────────────────
function openDb(): Database.Database {
  return new Database(DB_PATH);
}

interface AgentTask {
  id: string;
  title: string;
  description: string | null;
  assignee_id: string;
  assignee_name: string;
  department: string | null;
  priority: string;
  status: string;
}

function claimNextTask(db: Database.Database, busyAgents: string[]): AgentTask | null {
  const placeholders = busyAgents.map(() => '?').join(', ');
  const excludeClause = busyAgents.length > 0
    ? `AND assignee_id NOT IN (${placeholders})`
    : '';

  const row = db.prepare(`
    SELECT * FROM agent_tasks
    WHERE status = 'todo' ${excludeClause}
      AND (retry_after IS NULL OR retry_after <= datetime('now'))
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      updated_at ASC
    LIMIT 1
  `).get(...busyAgents) as AgentTask | undefined;

  if (!row) return null;

  // Atomically claim it — start at 10% so the UI shows movement
  const result = db.prepare(`
    UPDATE agent_tasks SET status = 'in_progress', progress = 10, updated_at = datetime('now')
    WHERE id = ? AND status = 'todo'
  `).run(row.id);

  return result.changes > 0 ? row : null;
}

function markAgentBusy(db: Database.Database, agentId: string, taskTitle: string): void {
  db.prepare(`
    UPDATE agents SET status = 'active', current_task = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(taskTitle, agentId);
}

function markAgentIdle(db: Database.Database, agentId: string): void {
  db.prepare(`
    UPDATE agents SET status = 'idle', current_task = '', updated_at = unixepoch()
    WHERE id = ?
  `).run(agentId);
}

function markTaskDone(db: Database.Database, taskId: string, result: string): void {
  db.prepare(`
    UPDATE agent_tasks
    SET status = 'done', progress = 100,
        description = COALESCE(description, '') || char(10) || '--- RESULT ---' || char(10) || ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(result.slice(0, 2000), taskId);
}

function saveToBrainVault(
  db: Database.Database,
  task: AgentTask,
  output: string,
  meta: { name: string; emoji: string; department: string },
): void {
  try {
    // Only save if output is meaningful (>100 chars)
    if (output.length < 100) return;

    const title = `${meta.emoji} ${task.title}`;
    const content = output.slice(0, 8000);
    const tags = [task.department ?? meta.department, task.priority].filter(Boolean).join(',');

    db.prepare(`
      INSERT INTO brain_vault (title, content, type, agent_id, agent_name, department, tags, source_task_id)
      VALUES (?, ?, 'report', ?, ?, ?, ?, ?)
    `).run(title, content, task.assignee_id, meta.name, meta.department, tags, task.id);
  } catch (_) {
    // Non-fatal — vault save failure shouldn't break task completion
  }
}

function markTaskFailed(db: Database.Database, taskId: string, error: string): void {
  db.prepare(`
    UPDATE agent_tasks
    SET status = 'failed', progress = 0,
        description = COALESCE(description, '') || char(10) || '--- ERROR ---' || char(10) || ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(error.slice(0, 500), taskId);
}

// ── Retry helpers ───────────────────────────────────────────────────────────
function getRetryCount(evidence: string | null): number {
  if (!evidence) return 0;
  try { return (JSON.parse(evidence) as { retries?: number }).retries ?? 0; } catch { return 0; }
}

function bumpRetryCount(db: Database.Database, taskId: string, current: number): void {
  const next = current + 1;
  let existing: Record<string, unknown> = {};
  try {
    const row = db.prepare('SELECT evidence FROM agent_tasks WHERE id = ?').get(taskId) as { evidence: string | null } | undefined;
    if (row?.evidence) existing = JSON.parse(row.evidence) as Record<string, unknown>;
  } catch { /* ignore */ }
  db.prepare(`UPDATE agent_tasks SET evidence = ? WHERE id = ?`)
    .run(JSON.stringify({ ...existing, retries: next }), taskId);
}

/**
 * Recover tasks stuck in `in_progress` for longer than STUCK_TASK_THRESHOLD_S.
 * Instead of permanently failing them, resets to 'todo' so the worker picks them
 * up again (up to MAX_RETRIES times). Only permanently fails after MAX_RETRIES.
 *
 * IMPORTANT: Tasks with skip_worker=1 are managed by manual Task tool sub-agents
 * (spawned by Thorn). They are intentionally left in_progress and must NEVER be
 * auto-claimed, reset, or touched by this recovery path.
 */
function recoverStuckTasks(db: Database.Database): void {
  const stuckTasks = db.prepare(`
    SELECT id, title, evidence FROM agent_tasks
    WHERE status = 'in_progress'
      AND skip_worker = 0
      AND (unixepoch('now') - unixepoch(updated_at)) > ?
  `).all(STUCK_TASK_THRESHOLD_S) as Array<{ id: string; title: string; evidence: string | null }>;

  for (const task of stuckTasks) {
    const retries = getRetryCount(task.evidence);
    if (retries >= MAX_RETRIES) {
      db.prepare(`
        UPDATE agent_tasks
        SET status = 'failed', progress = 0,
            description = COALESCE(description, '') || char(10) || '--- FAILED (sin recuperacion tras ${MAX_RETRIES} reintentos) ---',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(task.id);
      console.warn(`[worker] Task ${task.id} permanently failed after ${MAX_RETRIES} retries`);
    } else {
      db.prepare(`
        UPDATE agent_tasks
        SET status = 'todo', progress = 0,
            retry_after = datetime('now', '+${RETRY_DELAY_S} seconds'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(task.id);
      bumpRetryCount(db, task.id, retries);
      console.warn(`[worker] Task ${task.id} reset to todo (auto-retry ${retries + 1}/${MAX_RETRIES}) in ${RETRY_DELAY_S}s: ${task.title}`);
    }
  }
}

function setTaskProgress(db: Database.Database, taskId: string, progress: number): void {
  db.prepare(`
    UPDATE agent_tasks SET progress = ?, updated_at = datetime('now') WHERE id = ?
  `).run(progress, taskId);
}

function logActivity(
  db: Database.Database,
  agentId: string,
  agentName: string,
  emoji: string,
  type: string,
  action: string,
  department: string,
): void {
  db.prepare(`
    INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, type, action, department, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(agentId, agentName, emoji, type, action, department);
}

function getAgentMeta(db: Database.Database, agentId: string): { name: string; emoji: string; department: string } {
  const row = db.prepare(`SELECT name, emoji, department FROM agents WHERE id = ?`).get(agentId) as
    | { name: string; emoji: string; department: string }
    | undefined;
  return row ?? { name: agentId, emoji: '🤖', department: 'operations' };
}

// ── Team Chat helper (non-fatal) ─────────────────────────────────────────────
async function postTeamMessage(params: {
  thread_id: string;
  from_agent_id: string;
  from_agent_name: string;
  from_agent_emoji: string;
  to_agent_id?: string;
  to_agent_name?: string;
  message: string;
  message_type?: string;
}): Promise<void> {
  try {
    await fetch('http://localhost:3001/api/agent-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_type: 'message', ...params }),
    });
  } catch {
    // Non-fatal — dashboard may be restarting
  }
}

// ── Task runner ─────────────────────────────────────────────────────────────
async function executeTask(task: AgentTask): Promise<void> {
  const db = openDb();
  const meta = getAgentMeta(db, task.assignee_id);
  const persona = PERSONAS[task.assignee_id] ?? `${meta.name}, agente de OpoClaw`;

  console.log(`[worker] Starting task ${task.id} → ${task.assignee_id}: ${task.title}`);

  // Timers we need to cancel in both success and error paths
  let progressTimers: NodeJS.Timeout[] = [];
  let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  try {
    markAgentBusy(db, task.assignee_id, task.title);
    setTaskProgress(db, task.id, 25); // agent picked it up
    logActivity(db, task.assignee_id, meta.name, meta.emoji, 'task_started',
      `Iniciando: ${task.title}`, meta.department);
    db.close();

    // Post START message to Team Chat
    void postTeamMessage({
      thread_id: task.id,
      from_agent_id: task.assignee_id,
      from_agent_name: meta.name,
      from_agent_emoji: meta.emoji,
      message: `Iniciando tarea: ${task.title}`,
      message_type: 'message',
    });

    // Progress bumps: 50% at 15s, 75% at 2min
    const p50 = setTimeout(() => { const d = openDb(); setTaskProgress(d, task.id, 50); d.close(); }, 15_000);
    const p75 = setTimeout(() => { const d = openDb(); setTaskProgress(d, task.id, 75); d.close(); }, 2 * 60_000);
    progressTimers = [p50, p75];

    // Keepalive: re-log activity every 90s so agent stays green in Team Status during long tasks
    keepaliveInterval = setInterval(() => {
      const d = openDb();
      logActivity(d, task.assignee_id, meta.name, meta.emoji, 'info',
        `Trabajando en: ${task.title}`, meta.department);
      d.close();
    }, ACTIVE_KEEPALIVE_MS);

    // Build the execution prompt
    const prompt = `Eres ${persona}.

TAREA ASIGNADA: ${task.title}
${task.description ? `\nDETALLES:\n${task.description}` : ''}

INSTRUCCIONES:
- Ejecuta esta tarea de forma autónoma usando las herramientas disponibles (web search, bash, file system, etc.)
- Al final reporta: qué hiciste, qué encontraste, y el resultado concreto
- Sé conciso pero completo
- Reporta en español

LOGGING EN TIEMPO REAL (OBLIGATORIO):
Después de cada paso importante, registra tu progreso en el dashboard con estos comandos:

# Actividad (aparece en Activity Feed):
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db "INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('${task.assignee_id}', '${meta.name}', '${meta.emoji}', '[LO QUE ACABAS DE HACER]', 'info', '${meta.department}', datetime('now'))"

# Team Chat (aparece en la pantalla principal):
curl -s -X POST http://localhost:3001/api/agent-messages -H "Content-Type: application/json" -d '{"thread_id":"${task.id}","from_agent_id":"${task.assignee_id}","from_agent_name":"${meta.name}","from_agent_emoji":"${meta.emoji}","message":"[LO QUE ACABAS DE HACER]","message_type":"message"}'

Loggea al menos: al inicio, después de cada búsqueda/análisis importante, y al terminar.`;

    // Race agent execution against a hard timeout to prevent infinite hangs
    const result = await Promise.race([
      runAgent(prompt, undefined, () => {}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS / 60000}m`)), TASK_TIMEOUT_MS + 5000),
      ),
    ]);
    const output = result.text?.trim() || 'Tarea completada sin output.';

    progressTimers.forEach(clearTimeout);
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    const db2 = openDb();
    markTaskDone(db2, task.id, output);
    saveToBrainVault(db2, task, output, meta); // auto-save to Brain Vault
    markAgentIdle(db2, task.assignee_id);
    logActivity(db2, task.assignee_id, meta.name, meta.emoji, 'task_completed',
      `Completado: ${task.title}`, meta.department);
    db2.close();

    // Post DONE message to Team Chat
    void postTeamMessage({
      thread_id: task.id,
      from_agent_id: task.assignee_id,
      from_agent_name: meta.name,
      from_agent_emoji: meta.emoji,
      message: `Listo: ${task.title}. ${output.slice(0, 200)}${output.length > 200 ? '…' : ''}`,
      message_type: 'answer',
    });

    console.log(`[worker] Task ${task.id} done by ${task.assignee_id}`);
  } catch (err) {
    progressTimers.forEach(clearTimeout);
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    console.error(`[worker] Task ${task.id} failed:`, err);

    const db3 = openDb();
    const taskRow = db3.prepare('SELECT evidence FROM agent_tasks WHERE id = ?').get(task.id) as
      { evidence: string | null } | undefined;
    const retries = getRetryCount(taskRow?.evidence ?? null);

    if (retries < MAX_RETRIES) {
      // Auto-retry: reset to todo with a delay — agent-worker will pick it up after retry_after
      db3.prepare(`
        UPDATE agent_tasks
        SET status = 'todo', progress = 0,
            retry_after = datetime('now', '+${RETRY_DELAY_S} seconds'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(task.id);
      bumpRetryCount(db3, task.id, retries);
      logActivity(db3, task.assignee_id, meta.name, meta.emoji, 'warning',
        `Auto-retry ${retries + 1}/${MAX_RETRIES} en ${RETRY_DELAY_S}s: ${task.title}`, meta.department);
      console.warn(`[worker] Task ${task.id} queued for retry ${retries + 1}/${MAX_RETRIES} in ${RETRY_DELAY_S}s`);

      void postTeamMessage({
        thread_id: task.id,
        from_agent_id: task.assignee_id,
        from_agent_name: meta.name,
        from_agent_emoji: meta.emoji,
        message: `Reintentando (${retries + 1}/${MAX_RETRIES}): ${task.title}`,
        message_type: 'message',
      });
    } else {
      // Permanently failed — escalate: mark failed, notify dashboard + Telegram
      markTaskFailed(db3, task.id, String(err));
      logActivity(db3, task.assignee_id, meta.name, meta.emoji, 'error',
        `Fallo definitivo en tarea: ${task.title} — ${String(err).slice(0, 100)}`, meta.department);

      void postTeamMessage({
        thread_id: task.id,
        from_agent_id: task.assignee_id,
        from_agent_name: meta.name,
        from_agent_emoji: meta.emoji,
        message: `Fallo definitivo (${MAX_RETRIES} reintentos agotados): ${task.title}`,
        message_type: 'message',
      });

      // Notify Gonzalo only when a task truly can't be recovered
      import('child_process').then(({ exec }) => {
        const msg = `Tarea fallida sin recuperacion: "${task.title}" (asignada a ${meta.name}, ${MAX_RETRIES} intentos). Requiere atencion.`;
        exec(`bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "${msg.replace(/"/g, "'")}"`, { timeout: 10000 }, () => {});
      }).catch(() => {});
    }

    markAgentIdle(db3, task.assignee_id);
    db3.close();
  } finally {
    activeAgents.delete(task.assignee_id);
  }
}

// ── Budget gate ─────────────────────────────────────────────────────────────
// Returns true if the task should be blocked due to monthly budget overrun.
// Urgent and high priority tasks are always allowed through.
function isBudgetBlocked(db: Database.Database, task: AgentTask): boolean {
  // Urgent/high always run regardless of budget
  const priority = (task.priority ?? 'medium').toLowerCase();
  if (priority === 'urgent' || priority === 'high') return false;

  try {
    const now = new Date();
    const month = now.toISOString().slice(0, 7); // e.g. "2026-03"
    const alert = db.prepare(`SELECT threshold FROM budget_alerts WHERE month = ? ORDER BY threshold DESC LIMIT 1`).get(month) as { threshold: number } | undefined;
    if (!alert) return false; // no budget configured for this month

    // Compute start of current month and start of next month as Unix timestamps.
    // Using next month start avoids the invalid '-32' date trick.
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthStartSec = Math.floor(monthStart.getTime() / 1000);
    const nextMonthStartSec = Math.floor(nextMonthStart.getTime() / 1000);

    const costRow = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM token_usage
      WHERE created_at >= ? AND created_at < ?
    `).get(monthStartSec, nextMonthStartSec) as { total: number };

    const spent = costRow?.total ?? 0;
    const limit = alert.threshold * 1.5; // block at 150% of the soft alert threshold

    if (spent > limit) {
      console.warn(`[worker] Budget gate: $${spent.toFixed(2)} spent > $${limit.toFixed(2)} limit. Blocking medium/low task: ${task.title}`);
      return true;
    }
  } catch {
    // Non-fatal — don't block tasks if budget check fails
  }
  return false;
}

// ── Poll loop ───────────────────────────────────────────────────────────────
async function pollAndRun(): Promise<void> {
  if (activeAgents.size >= MAX_CONCURRENT) return;

  const db = openDb();
  // Recover any tasks that got stuck in_progress (e.g. from a previous crashed worker)
  recoverStuckTasks(db);
  const busyList = Array.from(activeAgents);
  const task = claimNextTask(db, busyList);

  if (task && isBudgetBlocked(db, task)) {
    // Put it back to todo so it doesn't get lost, but skip execution now
    db.prepare(`UPDATE agent_tasks SET status = 'todo', progress = 0, updated_at = datetime('now') WHERE id = ?`).run(task.id);
    db.close();
    return;
  }

  db.close();

  if (!task) return;

  // Don't run the same agent twice at once
  if (activeAgents.has(task.assignee_id)) return;

  activeAgents.add(task.assignee_id);
  // Fire and forget — poll loop continues
  void executeTask(task);
}

// ── Startup recovery ────────────────────────────────────────────────────────
// On startup, any task still 'in_progress' from a previous worker process is
// orphaned (no active Promise owns it). Reset them all to 'todo' immediately
// so they're re-queued without waiting for the 15-min threshold.
//
// IMPORTANT: Tasks with skip_worker=1 are managed by manual Task tool sub-agents
// (spawned by Thorn via the Claude Task tool). They are NOT orphaned — they are
// intentionally in_progress and must be left alone. Only reset tasks where
// skip_worker=0 (the default for worker-managed tasks).
function startupRecovery(db: Database.Database): void {
  const orphaned = db.prepare(`
    SELECT id, title, evidence FROM agent_tasks WHERE status = 'in_progress' AND skip_worker = 0
  `).all() as Array<{ id: string; title: string; evidence: string | null }>;

  for (const task of orphaned) {
    const retries = getRetryCount(task.evidence);
    if (retries >= MAX_RETRIES) {
      db.prepare(`
        UPDATE agent_tasks SET status = 'failed', progress = 0, updated_at = datetime('now') WHERE id = ?
      `).run(task.id);
      console.warn(`[worker] Startup: task ${task.id} permanently failed (${MAX_RETRIES} retries exhausted)`);
    } else {
      db.prepare(`
        UPDATE agent_tasks SET status = 'todo', progress = 0, retry_after = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(task.id);
      bumpRetryCount(db, task.id, retries);
      console.warn(`[worker] Startup: recovered orphaned task ${task.id} → todo (retry ${retries + 1}/${MAX_RETRIES}): ${task.title}`);
    }
  }
  if (orphaned.length > 0) {
    console.warn(`[worker] Startup recovery: ${orphaned.length} orphaned task(s) re-queued`);
  }
}

// ── Start ───────────────────────────────────────────────────────────────────
console.log(`[agent-worker] Started. Polling every ${POLL_INTERVAL_MS / 1000}s for pending tasks.`);
const startupDb = openDb();
startupRecovery(startupDb);
startupDb.close();
void pollAndRun(); // run immediately on start
setInterval(() => void pollAndRun(), POLL_INTERVAL_MS);
