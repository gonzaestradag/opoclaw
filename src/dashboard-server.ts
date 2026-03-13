import express, { Request, Response, NextFunction } from 'express';
import { execSync as execSyncShell, spawn as spawnProcess } from 'child_process';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { runAgent } from './agent.js';

// ── Augment express-session to include our custom fields ──────────
declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
    username?: string;
  }
}

// ── Skills directory ──────────────────────────────────────────────────
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

// ── DB path ───────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load specific vars from .env (PM2 doesn't inject them) ──────────
// Only load vars needed for Google OAuth — NOT DASHBOARD_PORT
const LOAD_FROM_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'ALLOWED_CHAT_ID', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'VAPI_API_KEY', 'VAPI_PHONE_NUMBER_ID', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ANTHROPIC_API_KEY', 'VAPI_WEBHOOK_SECRET', 'VAPI_ALLOWED_CALLERS', 'VAPI_ASSISTANT_ID', 'OWNER_VERIFIED_PHONE', 'DASHBOARD_URL', 'SESSION_SECRET', 'DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD_HASH', 'DASHBOARD_TOKEN', 'BINANCE_API_KEY', 'BINANCE_SECRET_KEY', 'OWNER_NAME'];
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (LOAD_FROM_ENV.includes(key)) process.env[key] = val;
  }
} catch { /* .env not found, skip */ }
const DB_PATH = path.join(__dirname, '..', 'store', 'claudeclaw.db');
const UPLOADS_DIR = path.join(__dirname, '..', 'store', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Honour the same env var that config.ts and bot.ts use so the URL in the
// Telegram /dashboard link actually points at the right port.
const PORT = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
const BUDGET_USD = parseFloat(process.env.BUDGET_USD || '50.0');

// ── Schema ────────────────────────────────────────────────────────────
const DASHBOARD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    title TEXT NOT NULL,
    department TEXT NOT NULL,
    role TEXT NOT NULL,
    emoji TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    current_task TEXT,
    reports_to TEXT,
    model TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_emoji TEXT NOT NULL,
    action TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'info',
    department TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agent_activity_created_at ON agent_activity(created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_activity_agent_id ON agent_activity(agent_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    assignee_id TEXT NOT NULL,
    assignee_name TEXT NOT NULL,
    assignee_emoji TEXT DEFAULT '⚙️',
    department TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'todo',
    progress INTEGER NOT NULL DEFAULT 0,
    delegated_by TEXT,
    evidence TEXT,
    retry_after TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_assignee ON agent_tasks(status, assignee_id);

  CREATE TABLE IF NOT EXISTS agent_approvals (
    id TEXT PRIMARY KEY,
    action_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'pending',
    action_data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS llm_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS morning_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    script TEXT,
    audio_path TEXT,
    sections TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brief_sections_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sections TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brief_context (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    used_at TEXT,
    status TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS agent_meetings (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    location TEXT DEFAULT 'virtual',
    gonzalo_present INTEGER NOT NULL DEFAULT 0,
    is_recording INTEGER NOT NULL DEFAULT 0,
    recording_duration TEXT,
    start_time TEXT NOT NULL DEFAULT (datetime('now')),
    end_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    role TEXT DEFAULT 'participant',
    joined_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'message',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_agenda_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_live_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_blind_spots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brain_vault (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'document',
    agent_id TEXT,
    agent_name TEXT,
    department TEXT,
    folder_path TEXT NOT NULL DEFAULT 'Varios',
    tags TEXT,
    source_task_id TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brain_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    parent_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_brain_vault_agent ON brain_vault(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_brain_vault_dept ON brain_vault(department, created_at);
  CREATE INDEX IF NOT EXISTS idx_brain_vault_folder ON brain_vault(folder_path, created_at);

  CREATE TABLE IF NOT EXISTS brain_files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'file',
    mimetype TEXT,
    size INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_brain_files_path ON brain_files(path);

  CREATE TABLE IF NOT EXISTS brain_stars (
    path TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_kpis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    label TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 0,
    target REAL NOT NULL DEFAULT 100,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_id, label)
  );

  CREATE TABLE IF NOT EXISTS slow_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_slow_requests_created_at ON slow_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_slow_requests_duration ON slow_requests(duration_ms DESC);

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    provider TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    token_expiry TEXT,
    account_email TEXT,
    last_sync_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    type TEXT DEFAULT 'meeting',
    all_day INTEGER DEFAULT 0,
    source TEXT DEFAULT 'google',
    external_id TEXT UNIQUE,
    external_url TEXT,
    agent_id TEXT,
    metadata TEXT,
    synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_calendar_events_time ON calendar_events(start_time, end_time);

  CREATE TABLE IF NOT EXISTS inbox_messages (
    id TEXT PRIMARY KEY,
    gmail_id TEXT UNIQUE,
    subject TEXT,
    sender TEXT,
    from_email TEXT,
    body_snippet TEXT,
    body_full TEXT,
    priority TEXT DEFAULT 'Medium',
    category TEXT DEFAULT 'work',
    ai_summary TEXT,
    ai_draft TEXT,
    starred INTEGER DEFAULT 0,
    read_msg INTEGER DEFAULT 0,
    has_draft INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL,
    account_email TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_timestamp ON inbox_messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_inbox_account_time ON inbox_messages(account_email, timestamp DESC);

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

  CREATE INDEX IF NOT EXISTS idx_llm_costs_created ON llm_costs(created_at);

  CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    from_agent_name TEXT NOT NULL,
    from_agent_emoji TEXT NOT NULL,
    to_agent_id TEXT,
    to_agent_name TEXT,
    message TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'message',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at DESC);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    files TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);

  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    vapi_call_id TEXT UNIQUE,
    to_number TEXT,
    contact_name TEXT,
    objective TEXT,
    status TEXT DEFAULT 'queued',
    duration_seconds INTEGER DEFAULT 0,
    transcript TEXT,
    outcome TEXT,
    objective_achieved INTEGER DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    ended_reason TEXT,
    task_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_calls_vapi_call_id ON calls(vapi_call_id);

  CREATE TABLE IF NOT EXISTS call_transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL,
    vapi_call_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    is_final INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_call_transcripts_call_id ON call_transcripts(call_id);
  CREATE INDEX IF NOT EXISTS idx_call_transcripts_vapi_call_id ON call_transcripts(vapi_call_id);

  CREATE TABLE IF NOT EXISTS dashboard_sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expired ON dashboard_sessions(expired);

  CREATE TABLE IF NOT EXISTS financial_transactions (
    id TEXT PRIMARY KEY,
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    area TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_financial_transactions_created_at ON financial_transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_financial_transactions_area ON financial_transactions(area, created_at DESC);

  CREATE TABLE IF NOT EXISTS business_areas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sector TEXT NOT NULL DEFAULT 'Other',
    status TEXT NOT NULL DEFAULT 'exploring',
    color TEXT NOT NULL DEFAULT '#60A5FA',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    relation TEXT,
    telegram_username TEXT,
    telegram_chat_id TEXT,
    email TEXT,
    phone TEXT,
    whatsapp TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_people_name ON people(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_people_telegram ON people(telegram_username);
`;

// ── Seed data ─────────────────────────────────────────────────────────
const SEED_AGENTS = [
  { id: 'thorn',         name: 'Thorn',   full_name: 'Thorn',             title: 'COO',                                department: 'executive',   role: 'executive',emoji: '🌵', status: 'active', model: null,                  reports_to: null },
  { id: 'marcus-reyes',  name: 'Marcus',  full_name: 'Marcus Reyes',       title: 'CTO — Director de Ingeniería',       department: 'engineering', role: 'director', emoji: '⚙️', status: 'idle',   model: 'claude-sonnet-4-5',   reports_to: 'thorn' },
  { id: 'lucas-park',    name: 'Lucas',   full_name: 'Lucas Park',          title: 'Frontend Engineer',                  department: 'engineering', role: 'employee', emoji: '🎨', status: 'idle',   model: 'claude-haiku-4-5',    reports_to: 'marcus-reyes' },
  { id: 'elias-mora',    name: 'Elias',   full_name: 'Elias Mora',          title: 'Backend & Infraestructura',          department: 'engineering', role: 'employee', emoji: '🔧', status: 'idle',   model: 'claude-sonnet-4-5',   reports_to: 'marcus-reyes' },
  { id: 'silas-vane',    name: 'Silas',   full_name: 'Silas Vane',          title: 'Automatización & DevOps',            department: 'engineering', role: 'employee', emoji: '⚡', status: 'idle',   model: 'claude-haiku-4-5',    reports_to: 'marcus-reyes' },
  { id: 'rafael-silva',  name: 'Rafael',  full_name: 'Dr. Rafael Silva',    title: 'CRO — Director de Inteligencia',     department: 'intelligence',role: 'director', emoji: '🔭', status: 'idle',   model: 'claude-sonnet-4-5',   reports_to: 'thorn' },
  { id: 'kaelen-ward',   name: 'Kaelen',  full_name: 'Kaelen Ward',         title: 'Research Analyst',                   department: 'intelligence',role: 'employee', emoji: '🔍', status: 'idle',   model: 'claude-haiku-4-5',    reports_to: 'rafael-silva' },
  { id: 'maya-chen',     name: 'Maya',    full_name: 'Maya Chen',           title: 'Directora de Operaciones',           department: 'operations',  role: 'director', emoji: '📋', status: 'idle',   model: 'claude-sonnet-4-5',   reports_to: 'thorn' },
  { id: 'jordan-walsh',  name: 'Jordan',  full_name: 'Jordan Walsh',        title: 'CFO — Director de Finanzas',         department: 'finance',     role: 'director', emoji: '💰', status: 'idle',   model: 'claude-haiku-4-5',    reports_to: 'thorn' },
  { id: 'sofia-ramos',   name: 'Sofia',   full_name: 'Sofía Ramos',         title: 'Directora de Contenido & Marca',     department: 'content',     role: 'director', emoji: '✍️', status: 'idle',   model: 'claude-sonnet-4-5',   reports_to: 'thorn' },
  { id: 'aria-nakamura', name: 'Aria',    full_name: 'Aria Nakamura',       title: 'CSO — Directora de Estrategia',      department: 'strategy',    role: 'director', emoji: '🎯', status: 'idle',   model: 'claude-sonnet-4-5',   reports_to: 'thorn' },
];

const SEED_KPIS = [
  // Thorn — CEO
  { agent_id: 'thorn',         label: 'Respuesta',       value: 92, target: 100 },
  { agent_id: 'thorn',         label: 'Precisión',       value: 88, target: 100 },
  { agent_id: 'thorn',         label: 'Velocidad',       value: 95, target: 100 },
  // Marcus — CTO
  { agent_id: 'marcus-reyes',  label: 'Code Quality',    value: 87, target: 100 },
  { agent_id: 'marcus-reyes',  label: 'Sprint Velocity', value: 78, target: 100 },
  { agent_id: 'marcus-reyes',  label: 'Uptime',          value: 99, target: 100 },
  // Lucas — Frontend
  { agent_id: 'lucas-park',    label: 'UI Accuracy',     value: 91, target: 100 },
  { agent_id: 'lucas-park',    label: 'Delivery',        value: 82, target: 100 },
  { agent_id: 'lucas-park',    label: 'Revisiones',      value: 74, target: 100 },
  // Elias — Backend
  { agent_id: 'elias-mora',    label: 'API Uptime',      value: 98, target: 100 },
  { agent_id: 'elias-mora',    label: 'Latencia',        value: 85, target: 100 },
  { agent_id: 'elias-mora',    label: 'Cobertura Tests', value: 71, target: 100 },
  // Silas — DevOps
  { agent_id: 'silas-vane',    label: 'Deploys/Sem',     value: 90, target: 100 },
  { agent_id: 'silas-vane',    label: 'Incidentes',      value: 96, target: 100 },
  { agent_id: 'silas-vane',    label: 'Automatización',  value: 83, target: 100 },
  // Rafael — CRO
  { agent_id: 'rafael-silva',  label: 'Insights/Sem',    value: 76, target: 100 },
  { agent_id: 'rafael-silva',  label: 'Precisión',       value: 89, target: 100 },
  { agent_id: 'rafael-silva',  label: 'Cobertura',       value: 81, target: 100 },
  // Kaelen — Research
  { agent_id: 'kaelen-ward',   label: 'Reportes',        value: 84, target: 100 },
  { agent_id: 'kaelen-ward',   label: 'Fuentes',         value: 92, target: 100 },
  { agent_id: 'kaelen-ward',   label: 'Velocidad',       value: 77, target: 100 },
  // Maya — COO
  { agent_id: 'maya-chen',     label: 'Tareas Cerradas', value: 88, target: 100 },
  { agent_id: 'maya-chen',     label: 'Reuniones',       value: 94, target: 100 },
  { agent_id: 'maya-chen',     label: 'Flujos Activos',  value: 79, target: 100 },
  // Jordan — CFO
  { agent_id: 'jordan-walsh',  label: 'Presupuesto',     value: 93, target: 100 },
  { agent_id: 'jordan-walsh',  label: 'Reportes',        value: 86, target: 100 },
  { agent_id: 'jordan-walsh',  label: 'Ahorro',          value: 72, target: 100 },
  // Sofia — Contenido
  { agent_id: 'sofia-ramos',   label: 'Publicaciones',   value: 80, target: 100 },
  { agent_id: 'sofia-ramos',   label: 'Engagement',      value: 67, target: 100 },
  { agent_id: 'sofia-ramos',   label: 'Calidad',         value: 91, target: 100 },
  // Aria — Estrategia
  { agent_id: 'aria-nakamura', label: 'Planes',          value: 75, target: 100 },
  { agent_id: 'aria-nakamura', label: 'OKRs',            value: 82, target: 100 },
  { agent_id: 'aria-nakamura', label: 'Iniciativas',     value: 69, target: 100 },
];

// Binding type that better-sqlite3 accepts
type SqlBinding = string | number | bigint | Buffer | null;

// ── Skill pattern tracker (in-memory) ────────────────────────────────
// Maps normalized keyword pattern → count of completed tasks matching it.
// When a pattern hits 3, we auto-propose a skill if one doesn't exist yet.
const _skillPatternCounts = new Map<string, number>();
// Track which patterns have already triggered a proposal to avoid spam.
const _skillPatternProposed = new Set<string>();

const SKILL_KEYWORDS: Record<string, string[]> = {
  'crear presentacion': ['presentacion', 'presentation', 'slides', 'deck', 'powerpoint', 'keynote'],
  'redactar reporte': ['reporte', 'report', 'informe', 'summary', 'resumen'],
  'agendar reunion': ['reunion', 'meeting', 'agendar', 'schedule', 'calendar', 'appointment', 'cita'],
  'busqueda de informacion': ['research', 'busca', 'buscar', 'investigar', 'find', 'search', 'web'],
  'email outreach': ['email', 'correo', 'outreach', 'cold', 'mensaje', 'draft'],
  'analisis competidores': ['competitor', 'competidor', 'analiz', 'market', 'mercado'],
  'generar documento': ['documento', 'document', 'contrato', 'contract', 'sow', 'nda'],
  'publicar contenido': ['post', 'publicar', 'linkedin', 'social', 'content', 'publish'],
};

function detectSkillPattern(title: string): string | null {
  const normalized = title.toLowerCase();
  for (const [pattern, keywords] of Object.entries(SKILL_KEYWORDS)) {
    if (keywords.some(kw => normalized.includes(kw))) return pattern;
  }
  return null;
}

// ── DB init ───────────────────────────────────────────────────────────
function initDashboardDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(DASHBOARD_SCHEMA);

  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, full_name, title, department, role, emoji, status, model, reports_to, updated_at)
    VALUES (@id, @name, @full_name, @title, @department, @role, @emoji, @status, @model, @reports_to, unixepoch())
  `);
  const insertKpi = db.prepare(`
    INSERT OR IGNORE INTO agent_kpis (agent_id, label, value, target)
    VALUES (@agent_id, @label, @value, @target)
  `);
  const seedAll = db.transaction(() => {
    for (const agent of SEED_AGENTS) {
      insertAgent.run(agent);
    }
    for (const kpi of SEED_KPIS) {
      insertKpi.run(kpi);
    }
  });
  seedAll();

  // ── Seed financial_transactions: insert initial capital if table is empty ──
  try {
    const ftCount = (db.prepare('SELECT COUNT(*) as cnt FROM financial_transactions').get() as { cnt: number }).cnt;
    if (ftCount === 0) {
      db.prepare(
        `INSERT INTO financial_transactions (id, amount, type, area, notes, created_at)
         VALUES ('seed-capital-001', 50, 'income', 'Other', 'Capital inicial', datetime('now'))`
      ).run();
    }
  } catch { /* ignore */ }

  // ── Seed business_areas if table is empty ──────────────────────────
  try {
    const baCount = (db.prepare('SELECT COUNT(*) as cnt FROM business_areas').get() as { cnt: number }).cnt;
    if (baCount === 0) {
      const seedAreas = [
        { id: 'ba-ai-agency',              name: 'AI Agency',              sector: 'Services',  status: 'active',    color: '#60A5FA', notes: 'Automatizaciones y agentes AI para clientes' },
        { id: 'ba-automation-consulting',  name: 'Automation Consulting',  sector: 'Services',  status: 'active',    color: '#34D399', notes: 'Consultoria en automatizacion de procesos' },
        { id: 'ba-crypto-trading',         name: 'Crypto Trading',         sector: 'Trading',   status: 'exploring', color: '#FACC15', notes: 'Trading algoritmico y posiciones cripto' },
        { id: 'ba-saas-tools',             name: 'Micro-SaaS Tools',       sector: 'Product',   status: 'exploring', color: '#A78BFA', notes: 'Herramientas SaaS de nicho con AI' },
        { id: 'ba-content-agency',         name: 'AI Content Agency',      sector: 'Content',   status: 'exploring', color: '#FB923C', notes: 'Produccion de contenido escalable con AI' },
      ];
      const insertArea = db.prepare(
        `INSERT OR IGNORE INTO business_areas (id, name, sector, status, color, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      );
      for (const a of seedAreas) {
        insertArea.run(a.id, a.name, a.sector, a.status, a.color, a.notes);
      }
    }
  } catch { /* ignore */ }

  // ── Migrate: add folder_path to brain_vault if missing ───────────
  try {
    const cols = db.prepare("PRAGMA table_info(brain_vault)").all() as Array<{ name: string }>;
    if (!cols.find(c => c.name === 'folder_path')) {
      db.exec("ALTER TABLE brain_vault ADD COLUMN folder_path TEXT NOT NULL DEFAULT 'Varios'");
    }
  } catch { /* already exists */ }

  // ── Migrate: add refresh_token to oauth_tokens if missing ────────
  try {
    const oauthCols = db.prepare("PRAGMA table_info(oauth_tokens)").all() as Array<{ name: string }>;
    if (!oauthCols.find(c => c.name === 'refresh_token')) {
      db.exec("ALTER TABLE oauth_tokens ADD COLUMN refresh_token TEXT");
    }
  } catch { /* already exists */ }

  // ── Migrate: add retry_after to agent_tasks if missing ───────────
  // Used by the agent-worker to schedule task retries with a delay.
  try {
    const taskCols = db.prepare("PRAGMA table_info(agent_tasks)").all() as Array<{ name: string }>;
    if (!taskCols.find(c => c.name === 'retry_after')) {
      db.exec("ALTER TABLE agent_tasks ADD COLUMN retry_after TEXT");
    }
    if (!taskCols.find(c => c.name === 'assignee_emoji')) {
      db.exec("ALTER TABLE agent_tasks ADD COLUMN assignee_emoji TEXT DEFAULT '⚙️'");
    }
  } catch { /* already exists */ }

  // ── Migrate: add from_number and direction to calls if missing ────
  try {
    const callCols = db.prepare("PRAGMA table_info(calls)").all() as Array<{ name: string }>;
    if (!callCols.find(c => c.name === 'from_number')) {
      db.exec("ALTER TABLE calls ADD COLUMN from_number TEXT");
    }
    if (!callCols.find(c => c.name === 'direction')) {
      db.exec("ALTER TABLE calls ADD COLUMN direction TEXT DEFAULT 'outbound'");
    }
    if (!callCols.find(c => c.name === 'caller_allowed')) {
      db.exec("ALTER TABLE calls ADD COLUMN caller_allowed INTEGER DEFAULT 1");
    }
    if (!callCols.find(c => c.name === 'cost_usd')) {
      db.exec("ALTER TABLE calls ADD COLUMN cost_usd REAL DEFAULT 0");
    }
    if (!callCols.find(c => c.name === 'notification_sent')) {
      db.exec("ALTER TABLE calls ADD COLUMN notification_sent INTEGER DEFAULT 0");
    }
  } catch { /* already exists */ }

  // ── Seed default folders ─────────────────────────────────────────
  const insertFolder = db.prepare(`
    INSERT OR IGNORE INTO brain_folders (path, name, parent_path)
    VALUES (?, ?, ?)
  `);
  const seedFolders = db.transaction(() => {
    insertFolder.run('Negocio', 'Negocio', null);
    insertFolder.run('Finanzas', 'Finanzas', null);
    insertFolder.run('Personal', 'Personal', null);
    insertFolder.run('Universidad', 'Universidad', null);
    insertFolder.run('Varios', 'Varios', null);
    insertFolder.run('Negocio/Planes', 'Planes', 'Negocio');
    insertFolder.run('Negocio/Reportes', 'Reportes', 'Negocio');
    insertFolder.run('Finanzas/2026', '2026', 'Finanzas');
    // Brain Drive folders
    insertFolder.run('Juntas', 'Juntas', null);
    insertFolder.run('Documentos', 'Documentos', null);
    insertFolder.run('Reportes', 'Reportes', null);
    insertFolder.run('Imagenes', 'Imagenes', null);
    insertFolder.run('Hojas de calculo', 'Hojas de calculo', null);
  });
  seedFolders();

  // ── Migrate: copy telegram_contacts → people (one-time, idempotent) ──
  try {
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_contacts'`
    ).get();
    if (tableExists) {
      db.exec(`
        INSERT OR IGNORE INTO people (name, relation, telegram_username, telegram_chat_id, email, created_at)
        SELECT name, relation, telegram_username, telegram_chat_id, email, created_at
        FROM telegram_contacts
      `);
      logger.info('Migrated telegram_contacts → people');
    }
  } catch (e) {
    logger.warn({ err: e }, 'telegram_contacts migration skipped');
  }

  return db;
}

// ── Rate limiters ─────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,          // 1 minuto
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

const agentsRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded for agent execution.' },
});

// ── Helpers ───────────────────────────────────────────────────────────
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Simple in-memory TTL cache ────────────────────────────────────────
interface CacheEntry { data: unknown; expiresAt: number }
const _cache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return undefined; }
  return entry.data;
}

function cacheSet(key: string, data: unknown, ttlMs: number): void {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function cacheInvalidate(prefix: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
}

// Periodic cache cleanup — evicts expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [key, entry] of _cache.entries()) {
    if (now > entry.expiresAt) {
      _cache.delete(key);
      evicted++;
    }
  }
  if (evicted > 0) {
    logger.debug(`[cache] Evicted ${evicted} expired entr${evicted === 1 ? 'y' : 'ies'}`);
  }
}, 5 * 60 * 1000).unref();

// ── AI inbox processing ───────────────────────────────────────────────────────

/**
 * Call claude CLI subprocess to process a single email.
 * This uses the same auth path as the rest of the system (Claude Code OAuth).
 * Pipes the prompt via stdin to avoid shell escaping / length issues.
 * Returns the raw text output from Claude.
 */
async function callClaudeCLI(prompt: string, timeoutMs: number = 90_000): Promise<string> {
  const { spawn } = await import('child_process');

  // Unset CLAUDECODE so the child process isn't blocked from starting a new session
  const childEnv = { ...process.env };
  delete childEnv['CLAUDECODE'];
  delete childEnv['CLAUDE_CODE_ENTRYPOINT'];

  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '--model', 'claude-haiku-4-5',
      '-p', '-',
      '--output-format', 'text',
    ], {
      timeout: timeoutMs,
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.on('error', reject);

    // Write prompt to stdin and close it
    child.stdin.write(prompt, 'utf-8');
    child.stdin.end();
  });
}

async function processOneEmailAI(db: Database.Database, msg: any): Promise<void> {
  const bodyText = (msg.body_full || msg.body_snippet || '').slice(0, 800);

  const ownerName = process.env['OWNER_NAME'] || 'the owner';
  const prompt = `You are Finn, an AI email assistant managing the business inbox for ${ownerName}, CEO of OpoClaw — an AI automation agency. Analyze this email and return ONLY valid JSON with no markdown, no explanation, no code fences.

OpoClaw context: We build AI agents, automation systems, and tech products for businesses. We do cold outreach, work with clients on Upwork and direct, and have affiliate partnerships.

Categories (pick exactly one):
- "to_respond": Email needs a reply (questions, client inquiries, partnership requests, Upwork messages, leads, invitations)
- "fyi": Informational — useful to read but no reply needed
- "notification": Automated system/app notifications, alerts, receipts, confirmations
- "marketing": Newsletters, unsolicited mass promos, ads
- "awaiting_reply": Thread where we already replied and are waiting on the other party
- "meeting_update": Calendar invites, meeting changes, RSVPs, cancellations
- "comment": Mentions/comments from collaboration tools
- "actioned": Conversation that appears finished or fully resolved

Subject: ${msg.subject}
From: ${msg.sender} <${msg.from_email}>
Body: ${bodyText}

Return ONLY this JSON (no other text):
{"category":"<one of 8 categories>","summary":"<1-2 sentence summary of what this email is about and what action if any is needed>","draft":"<if to_respond: write a direct professional reply on behalf of ${ownerName} at OpoClaw. Be concise, no emojis, no corporate fluff, match the tone of the email. Sign off as ${ownerName}, OpoClaw. Otherwise: null>"}`;

  let rawText: string;
  try {
    rawText = await callClaudeCLI(prompt, 90_000);
  } catch (err) {
    logger.warn({ msgId: msg.id, err }, '[processInboxAI] claude CLI call failed, skipping');
    return;
  }
  // Strip markdown code fences if any
  const text = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!text) return;

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({ msgId: msg.id, rawText: text.slice(0, 200), err }, '[processInboxAI] JSON parse failed');
    return;
  }

  const category = parsed.category ?? 'fyi';
  const hasDraft = category === 'to_respond' && parsed.draft && parsed.draft !== 'null';
  const priority = category === 'to_respond' ? 'High' : category === 'fyi' ? 'Medium' : 'Low';
  db.prepare(`UPDATE inbox_messages SET category = ?, ai_summary = ?, ai_draft = ?, has_draft = ?, priority = ? WHERE id = ?`)
    .run(category, parsed.summary ?? null, hasDraft ? parsed.draft : null, hasDraft ? 1 : 0, priority, msg.id);

  logger.info({ msgId: msg.id, category }, '[processInboxAI] email processed');
}

async function processInboxAI(db: Database.Database, messages: any[]): Promise<void> {
  if (messages.length === 0) return;

  // Process sequentially to avoid overwhelming the claude CLI with concurrent subprocesses
  // Each call takes ~5-15s; 20 emails = ~2-5 minutes max
  for (const msg of messages) {
    await processOneEmailAI(db, msg).catch(e => {
      logger.error({ msgId: msg.id, err: e }, '[processInboxAI] failed for message');
    });
  }
}

// ── OpoClaw Email Signature (HTML) ────────────────────────────────────────────
function buildEmailSignature(): string {
  // Gmail strips SVG — use pure HTML/CSS table cells to recreate the bars logo
  return `<div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="vertical-align:middle;padding-right:14px;border-right:2px solid #e5e7eb;">
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:22px;background-color:#6366f1;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:30px;background-color:#7171f3;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:16px;background-color:#8585f4;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:36px;background-color:#9999f7;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:10px;">
              <div style="width:7px;height:25px;background-color:#a5b4fc;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:middle;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;letter-spacing:3px;color:#6366f1;">OPOCLAW</span>
            </td>
          </tr>
        </table>
      </td>
      <td style="padding-left:14px;vertical-align:middle;">
        <div style="font-size:13px;font-weight:600;color:#111111;margin:0;">${process.env['OWNER_NAME'] || 'OpoClaw'}</div>
        <div style="font-size:12px;color:#6b7280;margin:2px 0 0;">CEO, OpoClaw</div>
        <div style="font-size:12px;color:#6b7280;margin:4px 0 0;"><a href="mailto:opoclaw@gmail.com" style="color:#6366f1;text-decoration:none;">opoclaw@gmail.com</a> &nbsp;&middot;&nbsp; <a href="https://opoclaw.com" style="color:#6366f1;text-decoration:none;">opoclaw.com</a></div>
      </td>
    </tr>
  </table>
</div>`;
}

// ── Gmail send helper ─────────────────────────────────────────────────────────
async function sendGmailMessage(accessToken: string, to: string, subject: string, body: string, inReplyToMsgId?: string): Promise<{ id: string }> {
  // Build HTML email with signature
  const signature = buildEmailSignature();
  const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111111;">`
    + `<div style="max-width:600px;padding:20px;">${body.replace(/\n/g, '<br/>')}</div>`
    + signature
    + `</body></html>`;

  // Encode subject as UTF-8 base64 to handle special chars
  const replySubject = subject.startsWith('Re:') ? subject : (inReplyToMsgId ? `Re: ${subject}` : subject);
  const encodedSubject = `=?UTF-8?B?${Buffer.from(replySubject, 'utf-8').toString('base64')}?=`;

  // Build MIME multipart message (plain text + HTML)
  const boundary = `boundary_${Date.now()}`;
  const emailLines = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (inReplyToMsgId) {
    emailLines.push(`In-Reply-To: ${inReplyToMsgId}`);
    emailLines.push(`References: ${inReplyToMsgId}`);
  }
  emailLines.push('');
  emailLines.push(`--${boundary}`);
  emailLines.push('Content-Type: text/plain; charset=utf-8');
  emailLines.push('');
  emailLines.push(body);
  emailLines.push('');
  emailLines.push(`--${boundary}`);
  emailLines.push('Content-Type: text/html; charset=utf-8');
  emailLines.push('Content-Transfer-Encoding: base64');
  emailLines.push('');
  // Base64-encode the HTML body in 76-char chunks (RFC 2045 requirement)
  const htmlBase64 = Buffer.from(htmlBody, 'utf-8').toString('base64');
  const htmlChunked = htmlBase64.match(/.{1,76}/g)?.join('\r\n') || htmlBase64;
  emailLines.push(htmlChunked);
  emailLines.push('');
  emailLines.push(`--${boundary}--`);

  const raw = Buffer.from(emailLines.join('\r\n')).toString('base64url');

  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!sendRes.ok) {
    const errBody = await sendRes.text();
    throw new Error(`Gmail send failed (${sendRes.status}): ${errBody}`);
  }

  return sendRes.json() as Promise<{ id: string }>;
}

// ── Agent-Worker Job Queue ─────────────────────────────────────────────
interface AgentJob {
  jobId: string;
  agent_id: string;
  task: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  created_at: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
}

const _jobQueue: AgentJob[] = [];
const _jobMap = new Map<string, AgentJob>();
let _jobRunning = false;
let _dashDb: Database.Database | null = null;

// Throttle: stale call cleanup runs at most once per 60 seconds, not on every poll
let _lastStaleCleanup = 0;

async function processNextJob(): Promise<void> {
  if (_jobRunning || _jobQueue.length === 0) return;
  const job = _jobQueue.shift();
  if (!job) return;

  _jobRunning = true;
  job.status = 'running';
  job.started_at = Date.now();

  try {
    if (_dashDb) {
      _dashDb.prepare(`
        INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
        VALUES (?, ?, '🤖', ?, 'task', 'executive', datetime('now'))
      `).run(job.agent_id, job.agent_id, `Job ${job.jobId}: ${job.task.slice(0, 80)}`);
    }

    const { spawn } = await import('child_process');
    const { openSync } = await import('fs');

    // Strip all CLAUDE* session vars so the subprocess can launch without conflict.
    // The dashboard server may run inside a Claude Code session (CLAUDECODE=1),
    // and the claude CLI refuses nested sessions unless these are cleared.
    const childEnv = { ...process.env };
    delete childEnv['CLAUDECODE'];
    delete childEnv['CLAUDE_CODE_ENTRYPOINT'];
    delete childEnv['CLAUDE_CODE_SESSION_ACCESS_TOKEN'];
    delete childEnv['CLAUDE_AGENT_SDK_VERSION'];

    // Use spawn instead of execFileAsync so we can connect stdin to /dev/null.
    // Without this, the claude CLI hangs waiting for terminal input when spawned
    // from a non-TTY parent process (PM2 dashboard-server has no real terminal).
    await new Promise<void>((resolve, reject) => {
      const devNull = openSync('/dev/null', 'r');
      const proc = spawn('claude', ['-p', job.task, '--output-format', 'text'], {
        env: childEnv,
        cwd: '/Users/opoclaw1/claudeclaw', // load CLAUDE.md + project settings
        stdio: [devNull, 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Task timed out after 10 minutes`));
      }, 10 * 60 * 1000);

      proc.on('close', (code) => {
        clearTimeout(killTimer);
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Command failed: claude -p ${job.task.slice(0, 80)} (exit ${code})`));
        }
      });
      proc.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });

    job.status = 'done';
    job.finished_at = Date.now();

    if (_dashDb) {
      _dashDb.prepare(`
        INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
        VALUES (?, ?, '🤖', ?, 'success', 'executive', datetime('now'))
      `).run(job.agent_id, job.agent_id, `Job ${job.jobId} completed`);
    }
  } catch (err) {
    job.status = 'failed';
    job.finished_at = Date.now();
    job.error = String(err);

    if (_dashDb) {
      _dashDb.prepare(`
        INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
        VALUES (?, ?, '🤖', ?, 'error', 'executive', datetime('now'))
      `).run(job.agent_id, job.agent_id, `Job ${job.jobId} failed: ${String(err).slice(0, 120)}`);
    }
  } finally {
    _jobRunning = false;
    if (_jobQueue.length > 0) {
      void processNextJob();
    }
  }
}

// ── App factory ───────────────────────────────────────────────────────
export function createDashboardApp(db: Database.Database): express.Application {
  _dashDb = db; // give the job queue access to the DB for logging
  const app = express();

  // ── Trust proxy (required for rate-limiter + correct IP behind ngrok/nginx) ─
  app.set('trust proxy', 1);

  // ── Gzip compression para todas las respuestas JSON ───────────────
  app.use(compression());

  app.use(cors({ origin: '*' }));
  // Capture raw body for Vapi HMAC verification before JSON parsing
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers['content-type']?.includes('application/json')) {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        (req as Request & { rawBody?: string }).rawBody = raw;
        try { req.body = JSON.parse(raw); } catch { req.body = {}; }
        next();
      });
    } else {
      next();
    }
  });

  // ── Rate limiting general en /api/* ───────────────────────────────
  // Exempt Vapi webhook endpoints from rate limiting so they're never blocked
  app.use('/api/', (req: Request, res: Response, next: NextFunction) => {
    const exempted = ['/api/calls/vapi-webhook', '/api/vapi/inbound', '/api/vapi/webhook', '/api/vapi', '/api/google-oauth', '/api/auth'];
    if (exempted.some(path => req.path === path || req.originalUrl.startsWith(path))) {
      return next();
    }
    return apiLimiter(req, res, next);
  });

  // ── Rate limiting estricto en /api/agents/run ─────────────────────
  app.use('/api/agents/run', agentsRunLimiter);

  // ── Slow request logger (>500ms → SQLite) ─────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 500) {
        const ip = req.ip ?? req.socket.remoteAddress ?? null;
        try {
          db.prepare(`
            INSERT INTO slow_requests (method, path, status_code, duration_ms, ip)
            VALUES (?, ?, ?, ?, ?)
          `).run(req.method, req.path, res.statusCode, duration, ip);
        } catch (_) {
          // No bloquear el request si falla el log
        }
      }
    });
    next();
  });

  // ── SQLite-backed session store (survives server restarts) ────────
  const Store = session.Store;
  class SQLiteStore extends Store {
    private _db: Database.Database;
    constructor(db: Database.Database) {
      super();
      this._db = db;
      // Prune expired sessions every 15 minutes
      setInterval(() => {
        try {
          this._db.prepare('DELETE FROM dashboard_sessions WHERE expired < ?').run(Date.now());
        } catch { /* ignore */ }
      }, 15 * 60 * 1000).unref();
    }
    get(sid: string, cb: (err: unknown, session?: session.SessionData | null) => void) {
      try {
        const row = this._db.prepare('SELECT sess, expired FROM dashboard_sessions WHERE sid = ?').get(sid) as { sess: string; expired: number } | undefined;
        if (!row || row.expired < Date.now()) return cb(null, null);
        cb(null, JSON.parse(row.sess) as session.SessionData);
      } catch (e) { cb(e); }
    }
    set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void) {
      try {
        const maxAge = (sess.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000);
        const expired = Date.now() + maxAge;
        this._db.prepare('INSERT OR REPLACE INTO dashboard_sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), expired);
        cb?.();
      } catch (e) { cb?.(e); }
    }
    destroy(sid: string, cb?: (err?: unknown) => void) {
      try {
        this._db.prepare('DELETE FROM dashboard_sessions WHERE sid = ?').run(sid);
        cb?.();
      } catch (e) { cb?.(e); }
    }
    touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void) {
      try {
        const maxAge = (sess.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000);
        const expired = Date.now() + maxAge;
        this._db.prepare('UPDATE dashboard_sessions SET expired = ? WHERE sid = ?').run(expired, sid);
        cb?.();
      } catch (e) { cb?.(e); }
    }
  }

  // ── Session middleware ─────────────────────────────────────────────
  const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback-change-me-in-env';
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore(db),
    cookie: {
      httpOnly: true,
      secure: false, // set true if serving over HTTPS only
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — "remember me" by default
    },
  }));

  // ── Login page (GET /login) ────────────────────────────────────────
  app.get('/login', (req: Request, res: Response) => {
    if (req.session.authenticated) {
      return res.redirect('/');
    }
    const error = req.query.error ? '<p class="error">Invalid username or password.</p>' : '';
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpoClaw — Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0a0f1a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #e2e8f0;
    }
    .card {
      background: #111827;
      border: 1px solid #1e2d45;
      border-radius: 16px;
      padding: 48px 40px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 25px 60px rgba(0,0,0,0.5);
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo-text {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #f8fafc;
    }
    .logo-sub {
      font-size: 12px;
      color: #64748b;
      margin-top: 4px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }
    .error {
      background: rgba(239,68,68,0.12);
      border: 1px solid rgba(239,68,68,0.3);
      color: #f87171;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 20px;
      text-align: center;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: #94a3b8;
      margin-bottom: 6px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      background: #0f172a;
      border: 1px solid #1e2d45;
      border-radius: 8px;
      padding: 12px 14px;
      color: #f1f5f9;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
      margin-bottom: 20px;
    }
    input:focus {
      border-color: #3b82f6;
    }
    button {
      width: 100%;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 13px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
      letter-spacing: 0.3px;
    }
    button:hover { background: #1d4ed8; }
    button:active { background: #1e40af; }
    .divider { height: 1px; background: #1e2d45; margin: 24px 0; }
    .hint {
      text-align: center;
      font-size: 12px;
      color: #475569;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-text">OpoClaw</div>
      <div class="logo-sub">Command Center</div>
    </div>
    ${error}
    <form method="POST" action="/login">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" autofocus required />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
    <div class="divider"></div>
    <p class="hint">Session stays active for 30 days.</p>
  </div>
</body>
</html>`);
  });

  // ── Login form handler (POST /login) ──────────────────────────────
  app.use('/login', express.urlencoded({ extended: false }));
  app.post('/login', async (req: Request, res: Response) => {
    const { username, password } = req.body as { username?: string; password?: string };
    const storedUsername = process.env.DASHBOARD_USERNAME || '';
    const storedHash = process.env.DASHBOARD_PASSWORD_HASH || '';
    if (!username || !password) {
      return res.redirect('/login?error=1');
    }
    const usernameMatch = username.trim() === storedUsername;
    let passwordMatch = false;
    try {
      passwordMatch = await bcrypt.compare(password, storedHash);
    } catch { /* invalid hash */ }
    if (!usernameMatch || !passwordMatch) {
      return res.redirect('/login?error=1');
    }
    req.session.authenticated = true;
    req.session.username = username.trim();
    return res.redirect('/');
  });

  // ── Logout (GET /logout) ──────────────────────────────────────────
  app.get('/logout', (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  // ── JSON auth endpoints (used by React SPA) ───────────────────────
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { username, passwordHash } = (req.body ?? {}) as { username?: string; passwordHash?: string };
    const storedUsername = process.env.DASHBOARD_USERNAME || '';
    const dashToken = process.env.DASHBOARD_TOKEN || '';
    const expectedHash = createHash('sha256').update(dashToken).digest('hex');
    if (username?.trim() === storedUsername && passwordHash === expectedHash) {
      req.session.authenticated = true;
      req.session.username = username.trim();
      return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
  });

  app.get('/api/auth/check', (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || '';
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
    res.json({ authenticated: req.session.authenticated === true || isLocal });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  // ── Auth guard — protects browser-facing routes from public access ──
  // Exemptions:
  //  - /login, /logout, /health (public routes)
  //  - /api/auth/* (JSON auth endpoints for React SPA)
  //  - /api/* from localhost (internal agent calls — never blocked)
  //  - Vapi webhook endpoints (called by external services, not browsers)
  const AUTH_EXEMPT_PATHS = ['/login', '/logout', '/health', '/api/auth', '/api/calls/vapi-webhook', '/api/vapi/inbound', '/api/vapi/webhook', '/api/vapi', '/api/telegram-webhook'];
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqPath = req.path;
    const isExempt = AUTH_EXEMPT_PATHS.some(p => reqPath === p || reqPath.startsWith(p + '/'));
    if (isExempt) return next();
    // Allow all localhost/internal API calls (agents, scripts, etc.)
    const clientIp = req.ip || req.socket.remoteAddress || '';
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
    if (isLocal && reqPath.startsWith('/api/')) return next();
    // Allow authenticated sessions
    if (req.session.authenticated) return next();
    // For remote API calls return 401 JSON; for browser requests redirect to /login
    if (reqPath.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login');
  });

  // ── GET /api/metrics ──────────────────────────────────────────────
  app.get('/api/metrics', (_req: Request, res: Response) => {
    try {
      const cached = cacheGet('metrics');
      if (cached) { res.json(cached); return; }

      const agentCounts = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status IN ('active', 'working') THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as working,
          SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END) as idle
        FROM agents
      `).get() as { total: number; active: number; working: number; idle: number };

      const taskCounts = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN lower(status) = 'done' AND date(updated_at) = date('now') THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN lower(status) = 'in_progress' THEN 1 ELSE 0 END) as in_progress
        FROM agent_tasks
      `).get() as { total: number; completed: number; in_progress: number };

      const pendingApprovals = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_approvals WHERE status = 'pending'`
      ).get() as { cnt: number }).cnt;

      const lastActivity = (db.prepare(
        `SELECT MAX(created_at) as ts FROM agent_activity`
      ).get() as { ts: string | null }).ts;

      const budgetUsed = (db.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total FROM llm_costs
         WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
      ).get() as { total: number }).total;

      const tasksToday = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_tasks
         WHERE date(created_at) = date('now')`
      ).get() as { cnt: number }).cnt;

      let costToday = 0;
      try {
        costToday = (db.prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) as total FROM token_usage
           WHERE date(created_at, 'unixepoch') = date('now')`
        ).get() as { total: number }).total;
      } catch { /* token_usage table may not exist */ }

      const briefToday = (db.prepare(
        `SELECT COUNT(*) as cnt FROM morning_briefs
         WHERE date(created_at) = date('now')`
      ).get() as { cnt: number }).cnt;

      const activeAgentsNow = (db.prepare(
        `SELECT COUNT(DISTINCT assignee_id) as cnt FROM agent_tasks
         WHERE lower(status) = 'in_progress'`
      ).get() as { cnt: number }).cnt;

      const metricsPayload = {
        activeAgents: activeAgentsNow ?? 0,
        workingAgents: agentCounts.working ?? 0,
        idleAgents: agentCounts.idle ?? 0,
        tasksCompleted: taskCounts.completed ?? 0,
        totalTasks: taskCounts.total ?? 0,
        tasksInProgress: taskCounts.in_progress ?? 0,
        pendingApprovals,
        riskAlerts: 0,
        systemOnline: true,
        lastActivity: lastActivity ?? null,
        budgetUsedUsd: Math.round(budgetUsed * 100) / 100,
        budgetTotalUsd: BUDGET_USD,
        budgetPercent: Math.round((budgetUsed / BUDGET_USD) * 100),
        tasksToday,
        costToday: Math.round(costToday * 10000) / 10000,
        briefStatus: briefToday > 0 ? 'sent' : 'pending',
      };
      cacheSet('metrics', metricsPayload, 8_000); // 8s TTL — dashboard polls every 15s
      res.json(metricsPayload);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/agents ───────────────────────────────────────────────
  const STATUS_NORMALIZE: Record<string, string> = {
    active: 'Active', idle: 'Idle', working: 'In Meeting',
    in_meeting: 'In Meeting', terminated: 'Terminated',
  };
  const DEPT_NORMALIZE: Record<string, string> = {
    executive: 'Executive', operations: 'Operations', intelligence: 'Intelligence',
    engineering: 'Engineering', finance: 'Finance', ventures: 'Ventures',
    content: 'Content', strategy: 'Strategy', revenue: 'Revenue',
    trading: 'Trading', creative: 'Creative',
  };

  function normalizeAgent(row: Record<string, unknown>) {
    const rawStatus = String(row['status'] ?? 'idle').toLowerCase();
    const rawDept   = String(row['department'] ?? 'operations').toLowerCase();
    const agentId   = String(row['id'] ?? '');
    return {
      ...row,
      status:     STATUS_NORMALIZE[rawStatus]     ?? row['status'],
      department: DEPT_NORMALIZE[rawDept]         ?? row['department'],
      avatarUrl:  `/avatars/${agentId}.png`,
      avatar:     `/avatars/${agentId}.png`,
    };
  }

  app.get('/api/agents', (_req: Request, res: Response) => {
    try {
      const cached = cacheGet('agents');
      if (cached) { res.json(cached); return; }
      const agents = (db.prepare(`SELECT * FROM agents ORDER BY role, name`).all() as Record<string, unknown>[]).map(normalizeAgent);
      cacheSet('agents', agents, 10_000); // 10s TTL
      res.json(agents);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/agents/:id ───────────────────────────────────────────
  app.get('/api/agents/:id', (req: Request, res: Response) => {
    try {
      const raw = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(req.params.id as string);
      if (!raw) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const agent = normalizeAgent(raw as Record<string, unknown>);

      const recentActivity = db.prepare(
        `SELECT * FROM agent_activity WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20`
      ).all(req.params.id as string);

      const tasks = db.prepare(
        `SELECT * FROM agent_tasks WHERE assignee_id = ? ORDER BY updated_at DESC`
      ).all(req.params.id as string);

      res.json({ ...agent, recentActivity, tasks });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/agents ─────────────────────────────────────────────
  // Create a new agent (auto-hiring) + auto-generate avatar via DALL-E 3
  app.post('/api/agents', async (req: Request, res: Response) => {
    try {
      const { id, name, full_name, title, department, role, emoji, model, reports_to, status } = req.body as Record<string, string>;
      if (!id || !name || !full_name || !title || !department || !role || !emoji) {
        res.status(400).json({ error: 'id, name, full_name, title, department, role, emoji are required' });
        return;
      }
      db.prepare(`
        INSERT OR REPLACE INTO agents (id, name, full_name, title, department, role, emoji, status, model, reports_to, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).run(id, name, full_name, title, department, role, emoji, status ?? 'idle', model ?? null, reports_to ?? null);
      cacheInvalidate('agents');

      // Auto-generate avatar in background (don't block the response)
      const avatarPath = path.join(__dirname, '..', 'dashboard', 'public', 'avatars', `${id}.png`);
      if (process.env.OPENAI_API_KEY && !fs.existsSync(avatarPath)) {
        (async () => {
          try {
            // Build a dynamic character description based on title/department
            const titleLower = (title ?? '').toLowerCase();
            const deptLower = (department ?? '').toLowerCase();
            let characterDesc: string;
            if (titleLower.includes('ceo') || titleLower.includes('chief executive')) {
              characterDesc = 'visionary CEO, commanding presence, sharp and confident, tailored dark suit';
            } else if (titleLower.includes('coo') || titleLower.includes('chief operating')) {
              characterDesc = 'COO, calm authority, operational precision, dark structured blazer';
            } else if (titleLower.includes('director') || titleLower.includes('head of') || titleLower.includes('lead')) {
              characterDesc = 'senior director, composed and strategic, professional dark attire, quiet authority';
            } else if (titleLower.includes('research') || titleLower.includes('intelligence') || titleLower.includes('analyst')) {
              characterDesc = 'intelligence analyst, intellectual and observant, dark fitted jacket, thoughtful expression';
            } else if (titleLower.includes('engineer') || titleLower.includes('developer') || titleLower.includes('architect')) {
              characterDesc = 'software engineer, focused and analytical, dark technical jacket over a dark shirt, sharp eyes';
            } else if (titleLower.includes('design') || titleLower.includes('creative') || titleLower.includes('ux') || titleLower.includes('ui')) {
              characterDesc = 'creative designer, perceptive and artistic, dark modern outfit, keen aesthetic eye';
            } else if (titleLower.includes('finance') || titleLower.includes('accounting') || titleLower.includes('budget')) {
              characterDesc = 'finance professional, precise and measured, dark business attire, trustworthy expression';
            } else if (titleLower.includes('ops') || titleLower.includes('operations') || titleLower.includes('logistics')) {
              characterDesc = 'operations specialist, efficient and reliable, dark fitted workwear, organised energy';
            } else if (titleLower.includes('content') || titleLower.includes('writer') || titleLower.includes('copy')) {
              characterDesc = 'content strategist, articulate and creative, dark smart-casual outfit, expressive';
            } else if (titleLower.includes('strategy') || titleLower.includes('growth') || titleLower.includes('product')) {
              characterDesc = 'strategist, visionary and decisive, dark structured jacket, forward-looking';
            } else if (deptLower.includes('engineering')) {
              characterDesc = 'technical professional, methodical and sharp, dark jacket, focused presence';
            } else if (deptLower.includes('intelligence')) {
              characterDesc = 'intelligence professional, perceptive and analytical, dark fitted attire';
            } else {
              characterDesc = `${title} professional, competent and focused, dark professional attire`;
            }
            const prompt = `3D animated character portrait, Pixar film quality. ${full_name} — ${characterDesc}. Professional, confident expression. Cinematic dark teal background, warm orange rim lighting from the right, dramatic shadows, head and shoulders composition.`;
            // Ensure the avatars directory exists
            const avatarsDir = path.dirname(avatarPath);
            if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });
            const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024', quality: 'standard' }),
            });
            const imgData = await imgRes.json() as { data?: Array<{ url?: string }> };
            const url = imgData.data?.[0]?.url;
            if (url) {
              const imgBuf = await fetch(url).then(r => r.arrayBuffer());
              fs.writeFileSync(avatarPath, Buffer.from(imgBuf));
              // Compress to 256×256 so avatars stay under ~120 KB (vs 1.6 MB raw DALL-E output)
              try {
                const { execSync } = await import('child_process');
                execSync(`sips -Z 256 "${avatarPath}" --out "${avatarPath}"`, { stdio: 'ignore' });
                logger.info(`Avatar compressed to 256px for ${id}`);
              } catch (compErr) {
                logger.warn({ compErr }, `Avatar compression failed for ${id}, keeping original`);
              }
              // Also copy to dist/avatars so it's served even without the /avatars route override
              const distAvatarPath = path.join(__dirname, '..', 'dashboard', 'dist', 'avatars', `${id}.png`);
              try {
                const distAvatarsDir = path.dirname(distAvatarPath);
                if (!fs.existsSync(distAvatarsDir)) fs.mkdirSync(distAvatarsDir, { recursive: true });
                fs.writeFileSync(distAvatarPath, fs.readFileSync(avatarPath));
                logger.info(`Avatar also copied to dist for ${id}`);
              } catch (copyErr) {
                logger.warn({ copyErr }, `Could not copy avatar to dist for ${id}`);
              }
              logger.info(`Avatar generated for ${id}: ${avatarPath}`);
            }
          } catch (err) {
            logger.warn({ err }, `Avatar generation failed for ${id}`);
          }
        })();
      }

      res.status(201).json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PATCH /api/agents/:id ─────────────────────────────────────────
  app.patch('/api/agents/:id', (req: Request, res: Response) => {
    try {
      const { status, current_task } = req.body as { status?: string; current_task?: string };
      const fields: string[] = [];
      const vals: (string | null)[] = [];
      if (status !== undefined)       { fields.push('status = ?');       vals.push(status); }
      if (current_task !== undefined) { fields.push('current_task = ?'); vals.push(current_task); }
      if (fields.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
      fields.push('updated_at = unixepoch()');
      vals.push(req.params.id as string);
      db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
      cacheInvalidate('agents');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/agent-messages ──────────────────────────────────────
  app.post('/api/agent-messages', (req: Request, res: Response) => {
    try {
      const { thread_id, from_agent_id, from_agent_name, from_agent_emoji, to_agent_id, to_agent_name, message, message_type } = req.body as Record<string, string>;
      if (!thread_id || !from_agent_id || !from_agent_name || !from_agent_emoji || !message) {
        res.status(400).json({ error: 'thread_id, from_agent_id, from_agent_name, from_agent_emoji, message are required' });
        return;
      }
      const result = db.prepare(`
        INSERT INTO agent_messages (thread_id, from_agent_id, from_agent_name, from_agent_emoji, to_agent_id, to_agent_name, message, message_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(thread_id, from_agent_id, from_agent_name, from_agent_emoji, to_agent_id ?? null, to_agent_name ?? null, message, message_type ?? 'message');
      res.status(201).json({ ok: true, id: result.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/agent-messages ───────────────────────────────────────
  app.get('/api/agent-messages', (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query['limit']) || 50, 200);
      const thread_id = req.query['thread_id'] as string | undefined;
      const since = req.query['since'] as string | undefined;
      const date = req.query['date'] as string | undefined; // YYYY-MM-DD in local time

      const conditions: string[] = [];
      const params: SqlBinding[] = [];
      if (thread_id) { conditions.push('thread_id = ?'); params.push(thread_id); }
      if (since)     { conditions.push('created_at > ?'); params.push(since); }
      if (date)      { conditions.push("date(created_at, 'localtime') = ?"); params.push(date); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const order = thread_id ? 'ASC' : 'DESC';
      const rows = db.prepare(`SELECT * FROM agent_messages ${where} ORDER BY created_at ${order} LIMIT ?`).all(...params, limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/agent-messages/recent ───────────────────────────────
  app.get('/api/agent-messages/recent', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare(
        `SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT 20`
      ).all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/activity/stream (SSE) ────────────────────────────────
  // Multiplexed real-time stream: activity, tasks, agents, messages.
  // Each event is: data: {"type":"activity"|"tasks"|"agents"|"messages", "rows":[...]}
  {
    const sseClients = new Set<Response>();
    // Expose push for use by webhook handlers outside this block
    const pushSSE = (payload: string) => {
      for (const client of sseClients) {
        try { client.write(payload); } catch { sseClients.delete(client); }
      }
    };
    // Register on the app object so webhook routes can access it
    (app as unknown as Record<string, unknown>)['_pushSSE'] = pushSSE;

    // Watermarks
    let lastActivityId = (() => {
      try { return (db.prepare(`SELECT MAX(id) as m FROM agent_activity`).get() as { m: number | null })?.m ?? 0; } catch { return 0; }
    })();
    let lastMessageId = (() => {
      try { return (db.prepare(`SELECT MAX(id) as m FROM agent_messages`).get() as { m: number | null })?.m ?? 0; } catch { return 0; }
    })();
    let lastTasksHash = '';
    let lastAgentsHash = '';
    let lastCallsHash = '';
    let lastTranscriptId = (() => {
      try { return (db.prepare(`SELECT MAX(id) as m FROM call_transcripts`).get() as { m: number | null })?.m ?? 0; } catch { return 0; }
    })();

    function push(clients: Set<Response>, payload: string) {
      for (const client of clients) {
        try { client.write(payload); } catch { clients.delete(client); }
      }
    }

    // Poll every 1s and push any changed data
    setInterval(() => {
      if (sseClients.size === 0) return;
      try {
        // Activity rows
        const newActivity = db.prepare(
          `SELECT * FROM agent_activity WHERE id > ? ORDER BY id ASC LIMIT 50`
        ).all(lastActivityId) as Array<{ id: number }>;
        if (newActivity.length > 0) {
          lastActivityId = newActivity[newActivity.length - 1]!.id;
          push(sseClients, `data: ${JSON.stringify({ type: 'activity', rows: newActivity })}\n\n`);
        }

        // Agent messages
        const newMessages = db.prepare(
          `SELECT * FROM agent_messages WHERE id > ? ORDER BY id ASC LIMIT 50`
        ).all(lastMessageId) as Array<{ id: number }>;
        if (newMessages.length > 0) {
          lastMessageId = newMessages[newMessages.length - 1]!.id;
          push(sseClients, `data: ${JSON.stringify({ type: 'messages', rows: newMessages })}\n\n`);
        }

        // Tasks (push on any change by hashing updated_at values)
        const tasks = db.prepare(`SELECT * FROM agent_tasks ORDER BY updated_at DESC LIMIT 50`).all();
        const tasksHash = (tasks as Record<string, unknown>[]).map((t) => `${t['id']}:${t['updated_at']}:${t['progress']}:${t['status']}`).join('|');
        if (tasksHash !== lastTasksHash) {
          lastTasksHash = tasksHash;
          push(sseClients, `data: ${JSON.stringify({ type: 'tasks', rows: tasks })}\n\n`);
        }

        // Agents (push on any status change)
        const agents = db.prepare(`SELECT * FROM agents ORDER BY name ASC`).all();
        const agentsHash = (agents as Record<string, unknown>[]).map((a) => `${a['id']}:${a['status']}:${a['updated_at']}`).join('|');
        if (agentsHash !== lastAgentsHash) {
          lastAgentsHash = agentsHash;
          push(sseClients, `data: ${JSON.stringify({ type: 'agents', rows: agents })}\n\n`);
        }

        // Calls (push on any change)
        try {
          // Stale-call cleanup: mark in_progress calls with no ended_at that are >10min old as completed.
          // This runs in the SSE loop so the dashboard auto-corrects even if a Vapi webhook was missed.
          // 10min window is enough for real calls; prevents test/duplicate records from lingering.
          const staleResult = db.prepare(`
            UPDATE calls
            SET status = 'completed',
                ended_reason = COALESCE(ended_reason, 'stale-cleanup'),
                outcome = COALESCE(outcome, 'failed'),
                ended_at = COALESCE(ended_at, datetime('now'))
            WHERE status IN ('in_progress', 'queued')
              AND (ended_at IS NULL OR ended_at = '')
              AND created_at < datetime('now', '-10 minutes')
          `).run();
          // Deduplication: if a call number has a newer completed record, close any older in_progress for same number
          db.prepare(`
            UPDATE calls SET status = 'completed', ended_reason = 'duplicate-dedup', ended_at = COALESCE(ended_at, datetime('now'))
            WHERE status IN ('in_progress', 'queued')
              AND to_number != ''
              AND to_number IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM calls c2
                WHERE c2.to_number = calls.to_number
                  AND c2.status = 'completed'
                  AND c2.created_at > calls.created_at
              )
          `).run();
          // If any stale calls were cleaned up, reset Thorn's status in case he was stuck "in a call"
          if (staleResult.changes > 0) {
            const activeCallExists = (db.prepare(`SELECT COUNT(*) as cnt FROM calls WHERE status IN ('in_progress', 'queued') AND (ended_at IS NULL OR ended_at = '')`).get() as { cnt: number })?.cnt ?? 0;
            if (activeCallExists === 0) {
              db.prepare(`UPDATE agents SET status = 'active', current_task = NULL, updated_at = unixepoch() WHERE id = 'thorn' AND status = 'working'`).run();
            }
          }

          const calls = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
          const callsHash = (calls as Record<string, unknown>[]).map((c) => `${c['id']}:${c['status']}:${c['outcome']}:${c['objective_achieved']}`).join('|');
          if (callsHash !== lastCallsHash) {
            lastCallsHash = callsHash;
            // Normalize contact_name so the live call banner shows correctly (same logic as GET /api/calls)
            const normalizedCalls = (calls as Record<string, unknown>[]).map((c) => ({
              ...c,
              contact_name: (c['contact_name'] as string | null) || (c['to_number'] as string | null) || 'Unknown',
              started_at: (c['started_at'] as string | null) || (c['created_at'] as string | null),
            }));
            push(sseClients, `data: ${JSON.stringify({ type: 'calls', rows: normalizedCalls })}\n\n`);
          }

          // Live call transcript turns
          try {
            const newTranscripts = db.prepare(
              `SELECT * FROM call_transcripts WHERE id > ? ORDER BY id ASC LIMIT 100`
            ).all(lastTranscriptId) as Array<{ id: number }>;
            if (newTranscripts.length > 0) {
              lastTranscriptId = newTranscripts[newTranscripts.length - 1]!.id;
              push(sseClients, `data: ${JSON.stringify({ type: 'call_transcript', rows: newTranscripts })}\n\n`);
            }
          } catch { /* call_transcripts table may not exist yet */ }
        } catch { /* calls table may not exist yet */ }
      } catch { /* db error — skip */ }
    }, 1000);

    // Heartbeat every 5s to keep connections alive through proxies
    setInterval(() => {
      push(sseClients, `: ping\n\n`);
    }, 5000);

    app.get('/api/activity/stream', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      sseClients.add(res);

      // Send current state immediately on connect
      try {
        const recentActivity = db.prepare(`SELECT * FROM agent_activity ORDER BY id DESC LIMIT 20`).all().reverse();
        const recentMessages = db.prepare(`SELECT * FROM agent_messages ORDER BY id DESC LIMIT 20`).all().reverse();
        const allTasks = db.prepare(`SELECT * FROM agent_tasks ORDER BY updated_at DESC LIMIT 50`).all();
        const allAgents = db.prepare(`SELECT * FROM agents ORDER BY name ASC`).all();
        res.write(`data: ${JSON.stringify({ type: 'activity', rows: recentActivity })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'messages', rows: recentMessages })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'tasks', rows: allTasks })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'agents', rows: allAgents })}\n\n`);
        try {
          const allCalls = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
          res.write(`data: ${JSON.stringify({ type: 'calls', rows: allCalls })}\n\n`);
          // Send recent transcript turns for any active calls
          try {
            const activeCallIds = (allCalls as Record<string, unknown>[])
              .filter(c => c['status'] === 'in_progress' || c['status'] === 'queued')
              .map(c => c['id'] as string);
            if (activeCallIds.length > 0) {
              const placeholders = activeCallIds.map(() => '?').join(',');
              const recentTurns = db.prepare(
                `SELECT * FROM call_transcripts WHERE call_id IN (${placeholders}) ORDER BY id ASC LIMIT 200`
              ).all(...activeCallIds);
              if (recentTurns.length > 0) {
                res.write(`data: ${JSON.stringify({ type: 'call_transcript', rows: recentTurns })}\n\n`);
              }
            }
          } catch { /* call_transcripts may not exist yet */ }
        } catch { /* calls table may not exist yet */ }
      } catch { /* skip */ }

      req.on('close', () => sseClients.delete(res));
    });
  }

  // ── GET /api/activity ─────────────────────────────────────────────
  app.get('/api/activity', (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query['limit']) || 25, 100);
      const agentId = req.query['agentId'] as string | undefined;
      const date = req.query['date'] as string | undefined; // YYYY-MM-DD in local time

      const cacheKey = `activity:${agentId ?? ''}:${limit}:${date ?? ''}`;
      const cached = cacheGet(cacheKey);
      if (cached) { res.json(cached); return; }

      const conditions: string[] = [];
      const params: SqlBinding[] = [];
      if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
      if (date)    { conditions.push("date(created_at, 'localtime') = ?"); params.push(date); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM agent_activity ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);

      cacheSet(cacheKey, rows, 8000); // 8s TTL
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Task normalization ────────────────────────────────────────────
  const TASK_STATUS_MAP: Record<string, string> = {
    backlog: 'To Do', todo: 'To Do', queued: 'Queued', in_progress: 'In Progress',
    review: 'In Progress', done: 'Done',
  };
  const TASK_PRIORITY_MAP: Record<string, string> = {
    low: 'Low', medium: 'Medium', high: 'High', urgent: 'High',
  };

  function normalizeTask(row: Record<string, unknown>) {
    const rawStatus   = String(row['status']   ?? 'todo').toLowerCase();
    const rawPriority = String(row['priority'] ?? 'medium').toLowerCase();
    // Mark tasks as stale if they've been in_progress for more than 15 minutes without an update
    const STALE_THRESHOLD_MINUTES = 15;
    const updatedAt = row['updated_at'] ? new Date(String(row['updated_at']) + 'Z') : null;
    const minutesSinceUpdate = updatedAt ? (Date.now() - updatedAt.getTime()) / 60000 : 0;
    const isStale = rawStatus === 'in_progress' && minutesSinceUpdate > STALE_THRESHOLD_MINUTES;
    return {
      ...row,
      status:   TASK_STATUS_MAP[rawStatus]     ?? row['status'],
      priority: TASK_PRIORITY_MAP[rawPriority] ?? row['priority'],
      stale: isStale,
    };
  }

  // ── GET /api/tasks ────────────────────────────────────────────────
  app.get('/api/tasks', (req: Request, res: Response) => {
    try {
      const status = req.query['status'] as string | undefined;
      const assigneeId = req.query['assigneeId'] as string | undefined;
      const date = req.query['date'] as string | undefined; // YYYY-MM-DD in local time

      const cacheKey = `tasks:${status ?? ''}:${assigneeId ?? ''}:${date ?? ''}`;
      const cached = cacheGet(cacheKey);
      if (cached) { res.json(cached); return; }

      const conditions: string[] = [];
      const params: SqlBinding[] = [];

      // Accept both capitalized and lowercase status in query
      if (status) {
        // Reverse-map: "In Progress" → "in_progress" etc.
        const reverseStatus = Object.entries(TASK_STATUS_MAP).find(([,v]) => v === status)?.[0] ?? status.toLowerCase();
        conditions.push('LOWER(status) = ?');
        params.push(reverseStatus);
      }
      if (assigneeId) {
        conditions.push('assignee_id = ?');
        params.push(assigneeId);
      }
      if (date) {
        conditions.push("date(created_at, 'localtime') = ?");
        params.push(date);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sqlQuery = `SELECT * FROM agent_tasks ${where} ORDER BY updated_at DESC`;

      const rows = (db.prepare(sqlQuery).all(...params) as Record<string, unknown>[]).map(normalizeTask);
      cacheSet(cacheKey, rows, 15_000); // 15s TTL — tasks are polled every 30s from the UI
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Task queue auto-promotion ─────────────────────────────────────
  // Per-agent promotion: when an agent's slot opens (done/cancelled/failed),
  // the next queued task for that same agent is promoted to in_progress.
  // Also supports a global fallback (legacy concurrency limit) for non-queued tasks.
  const QUEUE_CONCURRENCY_LIMIT = 4;

  // Per-agent auto-promote: promotes the highest-priority queued task for a
  // specific agent when they have no in_progress tasks remaining.
  function autoPromoteQueuedTask(assigneeId: string): void {
    try {
      const inProgressCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_tasks WHERE assignee_id = ? AND status IN ('in_progress', 'pending')`
      ).get(assigneeId) as { cnt: number }).cnt;

      if (inProgressCount > 0) return; // agent still busy

      const next = db.prepare(`
        SELECT id, title FROM agent_tasks
        WHERE assignee_id = ? AND status = 'queued'
        ORDER BY
          CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
          created_at ASC
        LIMIT 1
      `).get(assigneeId) as { id: string; title: string } | undefined;

      if (!next) return;

      db.prepare(
        `UPDATE agent_tasks SET status = 'in_progress', progress = 10, updated_at = datetime('now') WHERE id = ?`
      ).run(next.id);

      db.prepare(
        `INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
         VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`
      ).run(`Auto-promoted queued task for ${assigneeId}: ${next.title}`);

      logger.info(`[auto-promote] Task ${next.id} ("${next.title}") promoted queued → in_progress for agent ${assigneeId}`);
      cacheInvalidate('tasks');
      cacheInvalidate('metrics');
    } catch (err) {
      logger.error({ err }, `[auto-promote] Failed to promote queued task for agent ${assigneeId}`);
    }
  }

  // Global fallback: checks all agents with queued tasks and promotes where slots are open.
  function promoteNextTask(): void {
    try {
      // First: run per-agent promotion for all agents that have queued tasks
      const agentsWithQueued = db.prepare(
        `SELECT DISTINCT assignee_id FROM agent_tasks WHERE status = 'queued'`
      ).all() as { assignee_id: string }[];

      for (const { assignee_id } of agentsWithQueued) {
        autoPromoteQueuedTask(assignee_id);
      }

      // Then: legacy global concurrency check for todo/backlog tasks
      const inProgressCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_tasks WHERE status IN ('in_progress', 'pending')`
      ).get() as { cnt: number }).cnt;

      if (inProgressCount >= QUEUE_CONCURRENCY_LIMIT) return;

      const slots = QUEUE_CONCURRENCY_LIMIT - inProgressCount;
      for (let i = 0; i < slots; i++) {
        const next = db.prepare(
          `SELECT id, title, assignee_name FROM agent_tasks WHERE status IN ('todo', 'backlog') ORDER BY created_at ASC LIMIT 1`
        ).get() as { id: string; title: string; assignee_name: string } | undefined;

        if (!next) break;

        db.prepare(
          `UPDATE agent_tasks SET status = 'in_progress', progress = 10, updated_at = datetime('now') WHERE id = ?`
        ).run(next.id);

        db.prepare(
          `INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
           VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`
        ).run(`Auto-promoted task to in_progress: ${next.title}`);

        logger.info(`[task-queue] Auto-promoted task ${next.id} ("${next.title}") to in_progress`);
      }

      cacheInvalidate('tasks');
      cacheInvalidate('metrics');
    } catch (err) {
      logger.error({ err }, '[task-queue] Error in promoteNextTask');
    }
  }

  // ── PATCH /api/tasks/:id ──────────────────────────────────────────
  // State machine: todo → queued → in_progress → done
  // Escape hatches: any → cancelled | failed; failed/cancelled → todo (reopen)
  app.patch('/api/tasks/:id', (req: Request, res: Response) => {
    try {
      const { status, progress, collaborator } = req.body as { status?: string; progress?: number; collaborator?: { id: string; name: string; emoji?: string } };
      const setClauses: string[] = [];
      const params: SqlBinding[] = [];

      const VALID_TASK_STATUSES = ['todo', 'queued', 'in_progress', 'done', 'pending', 'completed', 'cancelled', 'failed'];
      if (status !== undefined && !VALID_TASK_STATUSES.includes(status)) {
        res.status(400).json({ error: 'Invalid status value' });
        return;
      }

      // ── State machine validation ───────────────────────────────────
      // Allowed transitions:
      //   todo        → queued | in_progress | cancelled | failed
      //   queued      → in_progress | todo | cancelled
      //   in_progress → done | todo | queued | cancelled | failed
      //   done        → todo (reopen)
      //   failed      → todo | in_progress (retry)
      //   cancelled   → todo | in_progress (reopen)
      //   pending     → in_progress | todo | cancelled
      //   completed   → todo (legacy alias for done)
      const ALLOWED_TRANSITIONS: Record<string, string[]> = {
        todo:        ['queued', 'in_progress', 'cancelled', 'failed'],
        queued:      ['in_progress', 'todo', 'cancelled'],
        in_progress: ['done', 'todo', 'queued', 'cancelled', 'failed'],
        done:        ['todo'],
        failed:      ['todo', 'in_progress'],
        cancelled:   ['todo', 'in_progress'],
        pending:     ['in_progress', 'todo', 'cancelled'],
        completed:   ['todo'],
      };

      if (status !== undefined) {
        const current = db.prepare(`SELECT status FROM agent_tasks WHERE id = ?`).get(req.params.id as string) as { status: string } | undefined;
        if (!current) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        const currentStatus = current.status.toLowerCase();
        const allowed = ALLOWED_TRANSITIONS[currentStatus] ?? [];
        if (status !== currentStatus && !allowed.includes(status)) {
          res.status(400).json({
            error: `Invalid transition: ${currentStatus} → ${status}. Allowed: ${allowed.join(', ') || 'none'}`,
          });
          return;
        }
      }

      if (status !== undefined) {
        setClauses.push('status = ?');
        params.push(status);
      }

      // Auto-adjust progress on state transitions
      let effectiveProgress = progress;
      if (status === 'done' || status === 'completed') {
        effectiveProgress = 100;
      } else if (status === 'todo' && progress === undefined) {
        effectiveProgress = 0;
      } else if (status === 'in_progress' && progress === undefined) {
        // Only auto-set to 10 if task was previously at 0 (just starting)
        const row = db.prepare(`SELECT progress FROM agent_tasks WHERE id = ?`).get(req.params.id as string) as { progress: number } | undefined;
        if (row && row.progress === 0) effectiveProgress = 10;
      }

      if (effectiveProgress !== undefined) {
        setClauses.push('progress = ?');
        params.push(effectiveProgress);
      }

      // Add collaborator to the JSON array if provided
      if (collaborator) {
        const task = db.prepare(`SELECT collaborators FROM agent_tasks WHERE id = ?`).get(req.params.id as string) as { collaborators: string } | undefined;
        if (task) {
          const existing: { id: string; name: string; emoji?: string }[] = JSON.parse(task.collaborators || '[]');
          if (!existing.find(c => c.id === collaborator.id)) {
            existing.push(collaborator);
            setClauses.push('collaborators = ?');
            params.push(JSON.stringify(existing));
          }
        }
      }

      if (setClauses.length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      setClauses.push(`updated_at = datetime('now')`);
      params.push(req.params.id as string);

      const result = db.prepare(
        `UPDATE agent_tasks SET ${setClauses.join(', ')} WHERE id = ?`
      ).run(...params);

      if (result.changes === 0) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const updated = db.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).get(req.params.id as string) as Record<string, unknown> | undefined;
      // Task counts changed — bust tasks and metrics cache
      cacheInvalidate('tasks');
      cacheInvalidate('metrics');
      res.json(updated);

      // Auto-promote next queued task if a slot just opened up
      if (status && ['done', 'completed', 'failed', 'cancelled'].includes(status)) {
        const assigneeId = updated?.['assignee_id'] as string | undefined;
        setImmediate(() => {
          // Per-agent promotion (queued → in_progress for same agent)
          if (assigneeId) autoPromoteQueuedTask(assigneeId);
          // Global fallback (todo/backlog → in_progress within concurrency limit)
          promoteNextTask();
        });
      }

      // ── Auto-skill-generation: detect repeated task patterns ─────────
      if (status && ['done', 'completed'].includes(status)) {
        const taskTitle = String(updated?.['title'] ?? '');
        const detectedPattern = detectSkillPattern(taskTitle);
        if (detectedPattern && !_skillPatternProposed.has(detectedPattern)) {
          const count = (_skillPatternCounts.get(detectedPattern) ?? 0) + 1;
          _skillPatternCounts.set(detectedPattern, count);

          if (count >= 3) {
            // Check if a skill file already exists for this pattern
            const skillSlug = detectedPattern.replace(/\s+/g, '-');
            const skillPath = path.join(SKILLS_DIR, skillSlug);
            const skillExists = fs.existsSync(skillPath) || fs.existsSync(skillPath + '.md');

            // Also check DB-persisted proposals table to prevent re-proposing across restarts
            let alreadyProposedInDb = false;
            try {
              const existing = db.prepare(
                `SELECT id FROM skill_proposals WHERE skill_slug = ?`
              ).get(skillSlug) as { id: number } | undefined;
              alreadyProposedInDb = !!existing;
            } catch { /* table may not exist yet — safe to ignore */ }

            if (!skillExists && !alreadyProposedInDb) {
              _skillPatternProposed.add(detectedPattern);
              setImmediate(async () => {
                try {
                  // Insert into skill_proposals table for persistent dedup
                  const nowTs = Math.floor(Date.now() / 1000);
                  try {
                    db.prepare(
                      `INSERT OR IGNORE INTO skill_proposals (skill_name, skill_slug, description, proposed_by, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'proposed', ?, ?)`
                    ).run(
                      detectedPattern,
                      skillSlug,
                      `System detected this task type completed 3+ times: "${detectedPattern}". Pattern matched on: "${taskTitle}". Consider creating a reusable skill for this workflow.`,
                      'system',
                      nowTs,
                      nowTs,
                    );
                  } catch { /* ignore if table missing */ }

                  const proposeId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
                  // Use status='in_progress' + skip_worker=1 so the agent-worker never auto-claims
                  // this task. Auto-proposed skill tasks are informational review items for Marcus —
                  // they are NOT meant to be executed autonomously by the worker loop.
                  db.prepare(`
                    INSERT INTO agent_tasks (id, title, description, assignee_id, assignee_name, department, priority, status, progress, skip_worker, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
                  `).run(
                    proposeId,
                    `Auto-proposed skill: ${detectedPattern}`,
                    `System detected this task type completed 3+ times: "${detectedPattern}". Pattern matched on: "${taskTitle}". Consider creating a reusable skill for this workflow.`,
                    'marcus-reyes',
                    'Marcus',
                    'engineering',
                    'low',
                    'in_progress',
                    now,
                    now,
                  );
                  // Notify via Telegram
                  const { execFile } = await import('child_process');
                  execFile('bash', ['/Users/opoclaw1/claudeclaw/scripts/tg-notify.sh',
                    `Sistema detecto un patron repetitivo y propuso un nuevo skill: ${detectedPattern}. Marcus lo revisa.`
                  ], (err) => {
                    if (err) logger.warn({ err }, '[skill-auto-propose] tg-notify failed');
                  });
                  logger.info(`[skill-auto-propose] Created skill proposal task ${proposeId} for pattern: ${detectedPattern}`);
                } catch (err) {
                  logger.error({ err }, '[skill-auto-propose] Failed to create skill proposal');
                }
              });
            }
          }
        }
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/tasks/promote-queued — manual trigger ────────────────
  // Scans all agents with queued tasks and promotes where slots are open.
  app.get('/api/tasks/promote-queued', (_req: Request, res: Response) => {
    try {
      const agents = db.prepare(
        `SELECT DISTINCT assignee_id FROM agent_tasks WHERE status = 'queued'`
      ).all() as { assignee_id: string }[];

      let promoted = 0;
      for (const { assignee_id } of agents) {
        const before = (db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_tasks WHERE assignee_id = ? AND status = 'in_progress'`
        ).get(assignee_id) as { cnt: number }).cnt;
        autoPromoteQueuedTask(assignee_id);
        const after = (db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_tasks WHERE assignee_id = ? AND status = 'in_progress'`
        ).get(assignee_id) as { cnt: number }).cnt;
        if (after > before) promoted++;
      }

      res.json({ ok: true, promoted, agents_checked: agents.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/tasks ───────────────────────────────────────────────
  // ── Worker: atomically claim next available task (for remote Air workers) ──
  app.post('/api/worker/claim', (req: Request, res: Response) => {
    try {
      const { busy_agents = [] } = req.body as { busy_agents?: string[] };
      const placeholders = busy_agents.map(() => '?').join(', ');
      const excludeClause = busy_agents.length > 0 ? `AND assignee_id NOT IN (${placeholders})` : '';

      const row = db.prepare(`
        SELECT * FROM agent_tasks
        WHERE status = 'todo' AND (skip_worker IS NULL OR skip_worker = 0) ${excludeClause}
          AND (retry_after IS NULL OR retry_after <= datetime('now'))
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at ASC
        LIMIT 1
      `).get(...busy_agents) as Record<string, unknown> | undefined;

      if (!row) { res.status(204).end(); return; }

      const result = db.prepare(`
        UPDATE agent_tasks SET status = 'in_progress', progress = 10, updated_at = datetime('now')
        WHERE id = ? AND status = 'todo'
      `).run(String(row['id']));

      if (result.changes === 0) { res.status(204).end(); return; }

      // Also get agent meta
      const agent = db.prepare(`SELECT name, emoji, department FROM agents WHERE id = ?`).get(String(row['assignee_id'])) as
        { name: string; emoji: string; department: string } | undefined;

      res.json({ ...row, agentMeta: agent ?? { name: row['assignee_id'], emoji: '🤖', department: 'operations' } });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Activity: log from remote workers ──────────────────────────────────────
  app.post('/api/activity', (req: Request, res: Response) => {
    try {
      const { agent_id, agent_name, agent_emoji, action, type, department } =
        req.body as { agent_id: string; agent_name: string; agent_emoji: string; action: string; type: string; department: string };
      db.prepare(`
        INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(agent_id, agent_name, agent_emoji, action, type, department);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/tasks', (req: Request, res: Response) => {
    try {
      const { title, description, assignee_id, assignee_name, department, priority, status, skip_worker } =
        req.body as {
          title: string;
          description?: string;
          assignee_id?: string;
          assignee_name?: string;
          department?: string;
          priority?: string;
          status?: string;
          skip_worker?: boolean | number;
        };

      if (!title?.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      // Determine skip_worker flag.
      // ALL tasks created via the API are managed by manual Task tool sub-agents
      // (spawned by Thorn). They must never be auto-claimed or reset by agent-worker.
      // Scheduler-managed tasks (worker queue) go through direct DB inserts, not this endpoint.
      // Default skip_worker=1 for every API-created task. Only tasks that explicitly
      // pass skip_worker=false/0 will be visible to the agent-worker.
      const resolvedStatus = (status ?? 'in_progress').toLowerCase().replace(' ', '_');
      const resolvedSkipWorker = skip_worker !== undefined
        ? (skip_worker ? 1 : 0)
        : 1;

      db.prepare(`
        INSERT INTO agent_tasks (id, title, description, assignee_id, assignee_name, department, priority, status, progress, skip_worker, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        id,
        title.trim(),
        description ?? null,
        assignee_id ?? 'thorn',
        assignee_name ?? 'Thorn',
        department ?? null,
        (priority ?? 'medium').toLowerCase(),
        resolvedStatus,
        resolvedSkipWorker,
        now,
        now,
      );

      const task = db.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).get(id) as Record<string, unknown>;
      cacheInvalidate('metrics');
      res.status(201).json(normalizeTask(task));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/tasks/queue-status ───────────────────────────────────
  app.get('/api/tasks/queue-status', (_req: Request, res: Response) => {
    try {
      const in_progress_count = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_tasks WHERE status IN ('in_progress', 'pending')`
      ).get() as { cnt: number }).cnt;

      const queued_count = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_tasks WHERE status IN ('todo', 'backlog')`
      ).get() as { cnt: number }).cnt;

      res.json({
        in_progress_count,
        queued_count,
        can_promote: queued_count > 0 && in_progress_count < QUEUE_CONCURRENCY_LIMIT,
        concurrency_limit: QUEUE_CONCURRENCY_LIMIT,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/approvals ────────────────────────────────────────────
  app.get('/api/approvals', (req: Request, res: Response) => {
    try {
      const status = req.query['status'] as string | undefined;
      let rows;
      if (status) {
        rows = db.prepare(
          `SELECT * FROM agent_approvals WHERE status = ? ORDER BY created_at DESC`
        ).all(status);
      } else {
        rows = db.prepare(
          `SELECT * FROM agent_approvals ORDER BY created_at DESC`
        ).all();
      }
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PATCH /api/approvals/:id ──────────────────────────────────────
  app.patch('/api/approvals/:id', (req: Request, res: Response) => {
    try {
      const { status } = req.body as { status?: string };
      if (!status || !['approved', 'rejected'].includes(status)) {
        res.status(400).json({ error: 'status must be approved or rejected' });
        return;
      }

      const result = db.prepare(
        `UPDATE agent_approvals SET status = ?, resolved_at = datetime('now') WHERE id = ?`
      ).run(status, req.params.id as string);

      if (result.changes === 0) {
        res.status(404).json({ error: 'Approval not found' });
        return;
      }

      const updated = db.prepare(`SELECT * FROM agent_approvals WHERE id = ?`).get(req.params.id as string);
      cacheInvalidate('metrics'); // pending approval count changed
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/meetings ─────────────────────────────────────────────
  // Optimized: batch-fetch all sub-tables in 5 queries total (not 5 × N).
  app.get('/api/meetings', (req: Request, res: Response) => {
    try {
      const statusFilter = req.query['status'] as string | undefined;
      const meetings = (statusFilter
        ? db.prepare(`SELECT * FROM agent_meetings WHERE status = ? ORDER BY start_time DESC`).all(statusFilter)
        : db.prepare(`SELECT * FROM agent_meetings ORDER BY start_time DESC`).all()
      ) as Array<Record<string, unknown>>;

      if (meetings.length === 0) {
        res.json([]);
        return;
      }

      const ids = meetings.map((m) => m['id'] as string);
      const placeholders = ids.map(() => '?').join(',');

      // Batch-fetch all related rows in 5 queries (instead of 5 × N)
      const participants = db.prepare(`SELECT * FROM meeting_participants WHERE meeting_id IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>;
      const messages     = db.prepare(`SELECT * FROM meeting_messages WHERE meeting_id IN (${placeholders}) ORDER BY created_at`).all(...ids) as Array<Record<string, unknown>>;
      const agenda       = db.prepare(`SELECT * FROM meeting_agenda_items WHERE meeting_id IN (${placeholders}) ORDER BY order_index`).all(...ids) as Array<Record<string, unknown>>;
      const liveNotes    = db.prepare(`SELECT * FROM meeting_live_notes WHERE meeting_id IN (${placeholders}) ORDER BY created_at`).all(...ids) as Array<Record<string, unknown>>;
      const blindSpots   = db.prepare(`SELECT * FROM meeting_blind_spots WHERE meeting_id IN (${placeholders}) ORDER BY created_at`).all(...ids) as Array<Record<string, unknown>>;

      // Group sub-rows by meeting_id
      function groupBy(rows: Array<Record<string, unknown>>, key = 'meeting_id'): Map<string, Array<Record<string, unknown>>> {
        const map = new Map<string, Array<Record<string, unknown>>>();
        for (const row of rows) {
          const k = row[key] as string;
          if (!map.has(k)) map.set(k, []);
          map.get(k)!.push(row);
        }
        return map;
      }

      const pMap  = groupBy(participants);
      const mMap  = groupBy(messages);
      const aMap  = groupBy(agenda);
      const lnMap = groupBy(liveNotes);
      const bsMap = groupBy(blindSpots);

      // Batch-fetch recordings linked to these meetings
      const recRows = db.prepare(`SELECT id, meeting_id, transcript, minuta, summary, action_items, duration_secs, created_at FROM recordings WHERE meeting_id IN (${placeholders})`).all(...ids) as Array<Record<string, unknown>>;
      const recMap = groupBy(recRows);

      const now = Date.now();
      const result = meetings.map((meeting) => {
        const id = meeting['id'] as string;
        // Compute live recording_duration if meeting is active and recording but duration not set
        let recordingDuration = meeting['recording_duration'] as string | null;
        if (!recordingDuration && meeting['is_recording'] && meeting['status'] === 'active') {
          // SQLite datetime('now') returns UTC without timezone suffix — add 'Z' to parse correctly
          const rawStart = (meeting['start_time'] as string).replace(' ', 'T') + 'Z';
          const startMs = new Date(rawStart).getTime();
          const elapsedSecs = Math.floor((now - startMs) / 1000);
          const hh = Math.floor(elapsedSecs / 3600);
          const mm = Math.floor((elapsedSecs % 3600) / 60);
          const ss = elapsedSecs % 60;
          recordingDuration = hh > 0
            ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
            : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
        }
        return {
          ...meeting,
          recording_duration: recordingDuration,
          participants: pMap.get(id)  ?? [],
          messages:     mMap.get(id)  ?? [],
          agenda:       aMap.get(id)  ?? [],
          liveNotes:    lnMap.get(id) ?? [],
          blindSpots:   bsMap.get(id) ?? [],
          recordings:   recMap.get(id) ?? [],
        };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/briefs ───────────────────────────────────────────────
  app.get('/api/briefs', (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query['limit']) || 10, 50);
      const cacheKey = `briefs:${limit}`;
      const cached = cacheGet(cacheKey);
      if (cached) { res.json(cached); return; }
      const rows = db.prepare(
        `SELECT * FROM morning_briefs ORDER BY created_at DESC LIMIT ?`
      ).all(limit);
      cacheSet(cacheKey, rows, 120_000); // briefs rarely change — 2min TTL
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Save a morning brief (called by scheduled task after generating podcast)
  app.post('/api/briefs', (req: Request, res: Response) => {
    const body = req.body as { date?: unknown; title?: unknown; script?: unknown; audio_path?: unknown; sections?: unknown };
    const { date, title, script, audio_path, sections } = body;
    if (!date) { res.status(400).json({ error: 'date is required' }); return; }
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    if (typeof date !== 'string' || !date.match(/^\d{4}-\d{2}-\d{2}/)) {
      res.status(400).json({ error: 'date must be a valid date string (YYYY-MM-DD)' });
      return;
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      res.status(400).json({ error: 'title must be a non-empty string' });
      return;
    }
    try {
      const stmt = db.prepare(
        `INSERT INTO morning_briefs (date, title, script, audio_path, sections, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      );
      const result = stmt.run(
        date,
        title,
        typeof script === 'string' ? script : null,
        typeof audio_path === 'string' ? audio_path : null,
        sections ? JSON.stringify(sections) : null,
      );
      cacheInvalidate('briefs:'); // bust the briefs cache on new insert
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Get brief sections config (5-minute in-memory cache)
  app.get('/api/brief-config', (_req: Request, res: Response) => {
    try {
      const cached = cacheGet('brief-config');
      if (cached) { res.json(cached); return; }
      const row = db.prepare('SELECT sections FROM brief_sections_config ORDER BY id DESC LIMIT 1').get() as { sections: string } | undefined;
      if (!row) {
        // Return defaults
        const defaults = [
          { id: 'markets', label: 'Markets (S&P, NASDAQ, BTC)', enabled: true, order: 1 },
          { id: 'news', label: 'AI News', enabled: true, order: 2 },
          { id: 'calendar', label: "Today's Calendar", enabled: true, order: 3 },
          { id: 'nightly', label: 'Nightly Work', enabled: true, order: 4 },
          { id: 'activity', label: 'Agent Activity', enabled: true, order: 5 },
          { id: 'approvals', label: 'Pending Approvals', enabled: true, order: 6 },
          { id: 'git', label: 'Git Changes', enabled: true, order: 7 },
        ];
        cacheSet('brief-config', defaults, 5 * 60 * 1000); // 5-minute TTL
        res.json(defaults);
        return;
      }
      try {
        const parsed = JSON.parse(row.sections);
        cacheSet('brief-config', parsed, 5 * 60 * 1000); // 5-minute TTL
        res.json(parsed);
      } catch {
        res.json([]);
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Save brief sections config (invalidates cache)
  app.post('/api/brief-config', (req: Request, res: Response) => {
    try {
      const { sections } = req.body as { sections?: unknown };
      if (!Array.isArray(sections)) { res.status(400).json({ error: 'sections must be an array' }); return; }
      // Upsert: delete old and insert new
      db.prepare('DELETE FROM brief_sections_config').run();
      db.prepare("INSERT INTO brief_sections_config (sections, updated_at) VALUES (?, datetime('now'))").run(JSON.stringify(sections));
      cacheInvalidate('brief-config'); // bust cache on update
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/briefs/context ────────────────────────────────────────
  // Returns pending context items by default; pass ?status=all to get all
  app.get('/api/briefs/context', (req: Request, res: Response) => {
    try {
      const all = req.query['status'] === 'all';
      const rows = all
        ? db.prepare('SELECT * FROM brief_context ORDER BY created_at ASC').all()
        : db.prepare("SELECT * FROM brief_context WHERE status = 'pending' ORDER BY created_at ASC").all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/briefs/context ───────────────────────────────────────
  app.post('/api/briefs/context', (req: Request, res: Response) => {
    try {
      const { content } = req.body as { content?: unknown };
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const id: string = randomBytes(8).toString('hex');
      db.prepare(
        "INSERT INTO brief_context (id, content, created_at, status) VALUES (?, ?, datetime('now'), 'pending')"
      ).run(id, content.trim());
      const row = db.prepare('SELECT * FROM brief_context WHERE id = ?').get(id);
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PATCH /api/briefs/context/:id ─────────────────────────────────
  app.patch('/api/briefs/context/:id', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { status } = req.body as { status?: unknown };
      const allowed = ['pending', 'used', 'dismissed'];
      if (!status || typeof status !== 'string' || !allowed.includes(status)) {
        res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
        return;
      }
      if (status === 'used') {
        db.prepare("UPDATE brief_context SET status = ?, used_at = datetime('now') WHERE id = ?").run(status, id);
      } else {
        db.prepare('UPDATE brief_context SET status = ?, used_at = NULL WHERE id = ?').run(status, id);
      }
      const row = db.prepare('SELECT * FROM brief_context WHERE id = ?').get(id);
      if (!row) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE /api/briefs/context/:id ────────────────────────────────
  app.delete('/api/briefs/context/:id', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      db.prepare('DELETE FROM brief_context WHERE id = ?').run(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/briefs/generate ──────────────────────────────────────
  // Triggers an on-demand morning brief (same prompt as the daily cron job).
  // Pending manual context items are injected automatically then marked used.
  app.post('/api/briefs/generate', (_req: Request, res: Response) => {
    try {
      const contextItems = db.prepare(
        "SELECT id, content FROM brief_context WHERE status = 'pending' ORDER BY created_at ASC"
      ).all() as Array<{ id: string; content: string }>;

      const contextBlock = contextItems.length > 0
        ? `\n\nAlso include these topics Gonzalo specifically requested:\n${contextItems.map(r => `- ${r.content}`).join('\n')}`
        : '';

      const generatePrompt = [
        `Genera el Morning Podcast diario para ${process.env['OWNER_NAME'] || 'el dueño del sistema'}. Pasos:`,
        '1) Lee /tmp/nightly_summary.txt para el resumen de mejoras nocturnas.',
        '   Revisa git log --since=yesterday en /Users/opoclaw1/Desktop/OpoClaw-mission-control',
        '   y /Users/opoclaw1/openclaw-gateway. Guarda resumen de cambios.',
        '2) Busca en la web las 3 noticias mas importantes de IA del dia.',
        '3) Busca precios actuales de S&P 500, NASDAQ y Bitcoin.',
        '4) Lee eventos del dia desde la DB:',
        '   sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db "SELECT title, start_time, end_time FROM calendar_events WHERE date(start_time) = date(\'now\', \'localtime\') ORDER BY start_time;"',
        '5) Revisa actividad de agentes (GET http://localhost:3001/api/activity?limit=20).',
        `6) Escribe un guion en espanol, conversacional, maximo 90 segundos, empieza con "Buenos dias ${process.env['OWNER_NAME'] || 'jefe'}".${contextBlock}`,
        '7) Guarda el guion en /tmp/podcast_script.txt',
        '8) Genera audio con ElevenLabs — NUNCA uses OpenAI TTS ni ninguna otra voz:\n   bash /Users/opoclaw1/claudeclaw/scripts/generate-podcast-audio.sh /tmp/podcast_script.txt /tmp/morning_podcast.mp3',
        '9) Guarda el brief via POST http://localhost:3001/api/briefs con date, title, script, audio_path, sections.',
        '10) Marca temas de contexto manual como usados:',
        '    sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db "UPDATE brief_context SET status=\'used\', used_at=datetime(\'now\') WHERE status=\'pending\'"',
        '11) Envia el audio por Telegram con caption.',
        '12) Notifica: bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "Listo. Brief generado on-demand y enviado."',
      ].join('\n');

      const child = spawnProcess('node', ['/Users/opoclaw1/claudeclaw/dist/index.js', 'spawn', generatePrompt], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      res.json({ ok: true, message: 'Brief generation started', contextItemCount: contextItems.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/costs ────────────────────────────────────────────────
  app.get('/api/costs', (_req: Request, res: Response) => {
    try {
      const cached = cacheGet('costs');
      if (cached) { res.json(cached); return; }

      const monthTotal = (db.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total FROM llm_costs
         WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
      ).get() as { total: number }).total;

      const byAgent = db.prepare(`
        SELECT
          lc.agent_id,
          COALESCE(a.name, lc.agent_id) as agent_name,
          SUM(lc.cost_usd) as cost_usd,
          COUNT(*) as calls
        FROM llm_costs lc
        LEFT JOIN agents a ON a.id = lc.agent_id
        WHERE strftime('%Y-%m', lc.created_at) = strftime('%Y-%m', 'now')
        GROUP BY lc.agent_id
        ORDER BY cost_usd DESC
      `).all();

      const daily = db.prepare(`
        SELECT
          strftime('%Y-%m-%d', created_at) as date,
          SUM(cost_usd) as cost_usd
        FROM llm_costs
        WHERE created_at >= date('now', '-30 days')
        GROUP BY date
        ORDER BY date
      `).all();

      const payload = {
        monthTotal: Math.round(monthTotal * 100) / 100,
        budget: BUDGET_USD,
        percentUsed: Math.round((monthTotal / BUDGET_USD) * 100),
        byAgent,
        daily,
      };
      cacheSet('costs', payload, 60_000); // costs change rarely — 60s TTL
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/system-status ────────────────────────────────────────
  app.get('/api/system-status', (_req: Request, res: Response) => {
    try {
      const cached = cacheGet('system-status') as Record<string, unknown> | undefined;
      if (cached) {
        // Always return fresh uptime/timestamp but use cached DB values
        res.json({ ...cached, uptime: process.uptime(), timestamp: new Date().toISOString() });
        return;
      }

      const agentCount = (db.prepare(`SELECT COUNT(*) as cnt FROM agents`).get() as { cnt: number }).cnt;
      const activeCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agents WHERE status IN ('active', 'working')`
      ).get() as { cnt: number }).cnt;

      const payload = {
        online: true,
        status: 'online',
        port: PORT,
        agentCount,
        activeAgents: activeCount,
        dbPath: DB_PATH,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
      cacheSet('system-status', payload, 12_000); // 12s TTL
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/kpis ─────────────────────────────────────────────────
  app.get('/api/kpis', (req: Request, res: Response) => {
    try {
      const agentId = req.query['agentId'] as string | undefined;
      const cacheKey = agentId ? `kpis:${agentId}` : 'kpis:all';
      const cached = cacheGet(cacheKey);
      if (cached) { res.json(cached); return; }

      let rows;
      if (agentId) {
        rows = db.prepare(
          `SELECT agent_id, label, value, target FROM agent_kpis WHERE agent_id = ? ORDER BY id`
        ).all(agentId);
      } else {
        rows = db.prepare(
          `SELECT agent_id, label, value, target FROM agent_kpis ORDER BY agent_id, id`
        ).all();
      }
      cacheSet(cacheKey, rows, 30_000); // KPIs change rarely — 30s TTL
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── INBOX ─────────────────────────────────────────────────────────
  app.get('/api/inbox', (req: Request, res: Response) => {
    try {
      const account = req.query['account'] as string | undefined;
      const cacheKey = `inbox:${account ?? 'all'}`;
      const cached = cacheGet(cacheKey);
      if (cached) { res.json(cached); return; }

      // Exclude body_full from list fetch — it can be large and is only needed when opening a message
      const INBOX_COLS = 'id, gmail_id, subject, sender, from_email, body_snippet, priority, category, ai_summary, ai_draft, starred, read_msg, has_draft, timestamp, account_email, synced_at';
      let rows;
      if (account && account !== 'all') {
        rows = db.prepare(`SELECT ${INBOX_COLS} FROM inbox_messages WHERE account_email = ? ORDER BY timestamp DESC LIMIT 100`).all(account);
      } else {
        rows = db.prepare(`SELECT ${INBOX_COLS} FROM inbox_messages ORDER BY timestamp DESC LIMIT 100`).all();
      }
      // Map read_msg → read for frontend compatibility
      const mapped = (rows as any[]).map((r: any) => ({
        ...r,
        read: Boolean(r.read_msg),
        starred: Boolean(r.starred),
        has_draft: Boolean(r.has_draft),
        hasDraft: Boolean(r.has_draft),
        draft: r.ai_draft ?? null,
        preview: r.body_snippet ?? '',
        agentRecommendation: r.ai_summary ?? null,
      }));
      cacheSet(cacheKey, mapped, 30_000); // 30s TTL
      res.json(mapped);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/inbox/sync', async (req: Request, res: Response) => {
    try {
      const { emails, accountEmail } = req.body as { emails: any[]; accountEmail: string };
      if (!Array.isArray(emails)) { res.status(400).json({ error: 'emails must be array' }); return; }
      if (!accountEmail || typeof accountEmail !== 'string' || !accountEmail.includes('@')) {
        res.status(400).json({ error: 'accountEmail must be a valid email address' });
        return;
      }

      // Check Gmail OAuth token expiry
      try {
        const gmailOauth = db.prepare(`SELECT token_expiry FROM oauth_tokens WHERE provider = 'gmail'`).get() as { token_expiry: string | null } | undefined;
        if (gmailOauth?.token_expiry) {
          const expiresAt = new Date(gmailOauth.token_expiry).getTime();
          const in24h = Date.now() + 24 * 60 * 60 * 1000;
          if (expiresAt < in24h) {
            db.prepare(`
              INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
              VALUES ('thorn', 'Thorn', '🌵', 'Gmail OAuth token expiring in < 24 hours - re-auth needed', 'warning', 'executive', datetime('now'))
            `).run();
          }
        }
      } catch { /* never block sync over a logging failure */ }

      let synced = 0;
      const upsert = db.prepare(`
        INSERT INTO inbox_messages (id, gmail_id, thread_id, subject, sender, from_email, body_snippet, body_full, starred, read_msg, timestamp, account_email, synced_at)
        VALUES (@id, @gmail_id, @thread_id, @subject, @sender, @from_email, @body_snippet, @body_full, @starred, @read_msg, @timestamp, @account_email, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          subject = excluded.subject, sender = excluded.sender, from_email = excluded.from_email,
          body_snippet = excluded.body_snippet, body_full = excluded.body_full,
          starred = excluded.starred, read_msg = excluded.read_msg, thread_id = excluded.thread_id, synced_at = datetime('now')
      `);

      const insertMany = db.transaction((...args: unknown[]) => {
        for (const e of args[0] as any[]) {
          upsert.run({
            id: e.id,
            gmail_id: e.gmail_id ?? e.id,
            thread_id: e.thread_id ?? null,
            subject: e.subject ?? '(no subject)',
            sender: e.sender ?? 'Unknown',
            from_email: e.from_email ?? '',
            body_snippet: e.body_snippet ?? '',
            body_full: e.body_full ?? '',
            starred: e.starred ? 1 : 0,
            read_msg: e.read ? 1 : 0,
            timestamp: e.timestamp ?? new Date().toISOString(),
            account_email: accountEmail,
          });
          synced++;
        }
      });
      insertMany(emails);

      // Queue AI processing for new messages without ai_summary
      const unprocessed = db.prepare(`SELECT id, subject, sender, body_snippet, body_full FROM inbox_messages WHERE ai_summary IS NULL AND account_email = ? LIMIT 20`).all(accountEmail) as any[];

      if (unprocessed.length > 0) {
        processInboxAI(db, unprocessed).catch((e: Error) => logger.error({ err: e }, '[inbox-ai]'));
      }

      cacheInvalidate('inbox'); // new emails arrived
      res.json({ ok: true, synced, queued_ai: unprocessed.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.patch('/api/inbox/:id', (req: Request, res: Response) => {
    try {
      const { read, starred, priority } = req.body as { read?: boolean; starred?: boolean; priority?: string };
      const VALID_PRIORITIES = ['High', 'Medium', 'Low'];
      if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
        res.status(400).json({ error: 'priority must be High, Medium, or Low' });
        return;
      }
      const updates: string[] = [];
      const params: any[] = [];
      if (read !== undefined) { updates.push('read_msg = ?'); params.push(read ? 1 : 0); }
      if (starred !== undefined) { updates.push('starred = ?'); params.push(starred ? 1 : 0); }
      if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
      if (updates.length === 0) { res.status(400).json({ error: 'nothing to update' }); return; }
      params.push(req.params.id);
      const result = db.prepare(`UPDATE inbox_messages SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      cacheInvalidate('inbox'); // read/starred state changed
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/inbox/:id/send — Approve & Send a draft reply ───────
  app.post('/api/inbox/:id/send', async (req: Request, res: Response) => {
    try {
      const msgId = req.params['id'] as string;
      const { access_token, body: draftBody } = req.body as { access_token?: string; body?: string };

      if (!access_token) {
        res.status(400).json({ error: 'access_token required — reconnect Gmail with send permission' });
        return;
      }

      // Fetch the message from DB
      const msg = db.prepare(`SELECT id, gmail_id, subject, from_email, ai_draft FROM inbox_messages WHERE id = ?`).get(msgId) as any;
      if (!msg) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      const replyBody = draftBody ?? msg.ai_draft;
      if (!replyBody) {
        res.status(400).json({ error: 'No draft to send — provide body or generate a draft first' });
        return;
      }

      // Send via Gmail API
      await sendGmailMessage(access_token, msg.from_email, msg.subject, replyBody, msg.gmail_id);

      // Mark as actioned, clear draft, mark read
      db.prepare(`UPDATE inbox_messages SET category = 'actioned', has_draft = 0, ai_draft = NULL, read_msg = 1 WHERE id = ?`).run(msgId);
      cacheInvalidate('inbox');

      logger.info({ msgId }, '[inbox-send] Draft approved and sent');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, '[inbox-send] failed');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('gmail.send') || msg.includes('403') || msg.includes('insufficient')) {
        res.status(403).json({ error: 'Gmail send permission not granted. Reconnect Gmail with send scope.', needs_reauth: true });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  });

  // ── POST /api/inbox/:id/reject — Reject a draft ───────────────────
  app.post('/api/inbox/:id/reject', (req: Request, res: Response) => {
    try {
      const msgId = req.params['id'] as string;
      const result = db.prepare(`UPDATE inbox_messages SET has_draft = 0, ai_draft = NULL WHERE id = ?`).run(msgId);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      cacheInvalidate('inbox');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/inbox/:id/reprocess — Re-run AI on a message ────────
  app.post('/api/inbox/:id/reprocess', async (req: Request, res: Response) => {
    try {
      const msgId = req.params['id'] as string;
      const msg = db.prepare(`SELECT id, subject, sender, from_email, body_snippet, body_full FROM inbox_messages WHERE id = ?`).get(msgId) as any;
      if (!msg) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      processInboxAI(db, [msg]).catch(e => logger.error({ err: e }, '[inbox-reprocess]'));
      res.json({ ok: true, message: 'AI reprocessing queued' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/inbox/reprocess-all — Bulk re-run AI on all unprocessed ──
  app.post('/api/inbox/reprocess-all', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number((req.body as any)?.limit) || 50, 200);
      const unprocessed = db.prepare(`SELECT id, subject, sender, from_email, body_snippet, body_full FROM inbox_messages WHERE ai_summary IS NULL LIMIT ?`).all(limit) as any[];
      if (unprocessed.length === 0) {
        res.json({ ok: true, queued: 0, message: 'All messages already processed' });
        return;
      }
      processInboxAI(db, unprocessed).catch(e => logger.error({ err: e }, '[inbox-reprocess-all]'));
      res.json({ ok: true, queued: unprocessed.length, message: `AI processing started for ${unprocessed.length} messages` });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/brain-vault ──────────────────────────────────────────
  app.get('/api/brain-vault', (req: Request, res: Response) => {
    try {
      const folder = req.query['folder'] as string | undefined;
      const search = req.query['search'] as string | undefined;
      const starred = req.query['starred'] as string | undefined;
      const limit = Math.min(Number(req.query['limit']) || 200, 500);

      const conditions: string[] = [];
      const params: SqlBinding[] = [];

      if (folder) {
        // Match exact folder or subfolders
        conditions.push("(folder_path = ? OR folder_path LIKE ?)");
        params.push(folder, `${folder}/%`);
      }
      if (search) {
        const safeSearch = search.slice(0, 200);
        conditions.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)');
        params.push(`%${safeSearch}%`, `%${safeSearch}%`, `%${safeSearch}%`);
      }
      if (starred === '1') { conditions.push('starred = 1'); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM brain_vault ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);

      const byFolder: Record<string, unknown[]> = {};
      for (const row of rows as Array<Record<string, unknown>>) {
        const fp = String(row['folder_path'] ?? 'Varios');
        if (!byFolder[fp]) byFolder[fp] = [];
        byFolder[fp].push(row);
      }

      res.json({ files: rows, count: (rows as unknown[]).length, byFolder });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/brain-vault/folders ──────────────────────────────────
  app.get('/api/brain-vault/folders', (_req: Request, res: Response) => {
    try {
      const folders = db.prepare(`SELECT * FROM brain_folders ORDER BY path ASC`).all() as Array<Record<string, unknown>>;
      // Attach doc counts
      const counts = db.prepare(`SELECT folder_path, COUNT(*) as cnt FROM brain_vault GROUP BY folder_path`).all() as Array<{ folder_path: string; cnt: number }>;
      const countMap: Record<string, number> = {};
      for (const c of counts) countMap[c.folder_path] = c.cnt;
      const withCounts = folders.map(f => ({ ...f, doc_count: countMap[String(f['path'])] ?? 0 }));
      res.json(withCounts);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/brain-vault/folders ─────────────────────────────────
  app.post('/api/brain-vault/folders', (req: Request, res: Response) => {
    try {
      const { path: folderPath, name, parent_path } = req.body as Record<string, string | undefined>;
      const trimmedName = (name ?? '').trim();
      if (!folderPath || !trimmedName) { res.status(400).json({ error: 'path and name required' }); return; }
      if (trimmedName.includes('..') || trimmedName.includes('/')) {
        res.status(400).json({ error: 'Folder name must not contain .. or /' });
        return;
      }
      db.prepare(`INSERT OR IGNORE INTO brain_folders (path, name, parent_path) VALUES (?, ?, ?)`).run(folderPath, trimmedName, parent_path ?? null);
      const created = db.prepare(`SELECT * FROM brain_folders WHERE path = ?`).get(folderPath);
      res.status(201).json(created);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── DELETE /api/brain-vault/folders ──────────────────────────────
  // ?path=Negocio/Planes
  app.delete('/api/brain-vault/folders', (req: Request, res: Response) => {
    try {
      const folderPath = String(req.query['path'] ?? '');
      if (!folderPath) { res.status(400).json({ error: 'path query param required' }); return; }
      db.prepare(`DELETE FROM brain_folders WHERE path = ? OR path LIKE ?`).run(folderPath, `${folderPath}/%`);
      db.prepare(`UPDATE brain_vault SET folder_path = 'Varios' WHERE folder_path = ? OR folder_path LIKE ?`).run(folderPath, `${folderPath}/%`);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── POST /api/brain-vault ─────────────────────────────────────────
  app.post('/api/brain-vault', (req: Request, res: Response) => {
    try {
      const { title, content, type, agent_id, agent_name, department, folder_path, tags, source_task_id, starred } = req.body as Record<string, string | number | undefined>;
      const trimmedTitle = typeof title === 'string' ? title.trim() : '';
      const trimmedContent = typeof content === 'string' ? content.trim() : (content ?? '');
      if (!trimmedTitle) { res.status(400).json({ error: 'Title is required' }); return; }
      if (!trimmedContent) { res.status(400).json({ error: 'title and content required' }); return; }
      if (String(trimmedContent).length > 500000) { res.status(400).json({ error: 'Content too large (max 500KB)' }); return; }

      const resolvedFolder = String(folder_path ?? department ?? 'Varios');

      const result = db.prepare(`
        INSERT INTO brain_vault (title, content, type, agent_id, agent_name, department, folder_path, tags, source_task_id, starred)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(trimmedTitle, trimmedContent, type ?? 'document', agent_id ?? null, agent_name ?? null, department ?? resolvedFolder, resolvedFolder, tags ?? null, source_task_id ?? null, starred ? 1 : 0);

      // Auto-create folder if not exists
      const parts = resolvedFolder.split('/');
      let built = '';
      for (const part of parts) {
        const prev = built;
        built = built ? `${built}/${part}` : part;
        db.prepare(`INSERT OR IGNORE INTO brain_folders (path, name, parent_path) VALUES (?, ?, ?)`).run(built, part, prev || null);
      }

      const created = db.prepare(`SELECT * FROM brain_vault WHERE id = ?`).get(result.lastInsertRowid);
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PATCH /api/brain-vault/:id/move ───────────────────────────────
  app.patch('/api/brain-vault/:id/move', (req: Request, res: Response) => {
    try {
      const { folder_path } = req.body as Record<string, string | undefined>;
      if (!folder_path) { res.status(400).json({ error: 'folder_path required' }); return; }
      const id = String(req.params['id'] ?? '');
      const result = db.prepare(`UPDATE brain_vault SET folder_path = ?, updated_at = datetime('now') WHERE id = ?`).run(folder_path, id);
      if (result.changes === 0) { res.status(404).json({ error: 'Document not found' }); return; }
      const updated = db.prepare(`SELECT * FROM brain_vault WHERE id = ?`).get(id);
      res.json(updated);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── PATCH /api/brain-vault/:id/star ───────────────────────────────
  app.patch('/api/brain-vault/:id/star', (req: Request, res: Response) => {
    try {
      const id = String(req.params['id'] ?? '');
      const result = db.prepare(`UPDATE brain_vault SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END, updated_at = datetime('now') WHERE id = ?`).run(id);
      if (result.changes === 0) { res.status(404).json({ error: 'Document not found' }); return; }
      const updated = db.prepare(`SELECT * FROM brain_vault WHERE id = ?`).get(id);
      res.json(updated);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── DELETE /api/brain-vault/:id ───────────────────────────────────
  app.delete('/api/brain-vault/:id', (req: Request, res: Response) => {
    try {
      const id = String(req.params['id'] ?? '');
      const result = db.prepare(`DELETE FROM brain_vault WHERE id = ?`).run(id);
      if (result.changes === 0) { res.status(404).json({ error: 'Document not found' }); return; }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── BRAIN FILE STORAGE (/api/brain) ──────────────────────────────
  const BRAIN_ROOT = path.join(__dirname, '..', 'workspace', 'brain');

  // Ensure default folders exist on startup
  const DEFAULT_BRAIN_FOLDERS = ['Juntas', 'Documentos', 'Reportes', 'Imagenes', 'Hojas de calculo'];
  for (const folder of DEFAULT_BRAIN_FOLDERS) {
    const folderPath = path.join(BRAIN_ROOT, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
  }

  function getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.zip': 'application/zip',
      '.json': 'application/json',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  function readBrainDir(relPath: string): Array<{ name: string; path: string; type: 'folder' | 'file'; size?: number; mimetype?: string; modified?: string }> {
    const absPath = path.join(BRAIN_ROOT, relPath);
    if (!fs.existsSync(absPath)) return [];
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const results: Array<{ name: string; path: string; type: 'folder' | 'file'; size?: number; mimetype?: string; modified?: string }> = [];
    for (const entry of entries) {
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push({ name: entry.name, path: entryRelPath, type: 'folder' });
      } else {
        const stat = fs.statSync(path.join(BRAIN_ROOT, entryRelPath));
        results.push({ name: entry.name, path: entryRelPath, type: 'file', size: stat.size, mimetype: getMimeType(entry.name), modified: stat.mtime.toISOString() });
      }
    }
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return results;
  }

  // GET /api/brain — list root contents
  app.get('/api/brain', (_req: Request, res: Response) => {
    try {
      res.json({ path: '', items: readBrainDir('') });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // GET /api/brain/folder?path=Juntas/2026 — list folder contents
  app.get('/api/brain/folder', (req: Request, res: Response) => {
    try {
      const relPath = String(req.query['path'] ?? '').replace(/\.\./g, '').replace(/^\//, '');
      res.json({ path: relPath, items: readBrainDir(relPath) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // POST /api/brain/folder — create a new folder { path: "Juntas/Marzo" }
  app.post('/api/brain/folder', (req: Request, res: Response) => {
    try {
      const relPath = String((req.body as Record<string, unknown>)['path'] ?? '').replace(/\.\./g, '').replace(/^\//, '');
      if (!relPath) return res.status(400).json({ error: 'path required' });
      fs.mkdirSync(path.join(BRAIN_ROOT, relPath), { recursive: true });
      res.json({ ok: true, path: relPath });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // POST /api/brain/upload — upload a file (base64 JSON: { path, filename, data, mimetype })
  app.post('/api/brain/upload', (req: Request, res: Response) => {
    try {
      const { path: relDir, filename, data, mimetype } = req.body as { path?: string; filename: string; data: string; mimetype?: string };
      if (!filename || !data) return res.status(400).json({ error: 'filename and data required' });
      const safeRelDir = String(relDir ?? '').replace(/\.\./g, '').replace(/^\//, '');
      const safeFilename = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');
      const targetDir = path.join(BRAIN_ROOT, safeRelDir);
      fs.mkdirSync(targetDir, { recursive: true });
      const filePath = path.join(targetDir, safeFilename);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      const stat = fs.statSync(filePath);
      const fileRelPath = safeRelDir ? `${safeRelDir}/${safeFilename}` : safeFilename;
      const id = `bf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      db.prepare(`INSERT OR REPLACE INTO brain_files (id, name, path, type, mimetype, size, created_at) VALUES (?, ?, ?, 'file', ?, ?, datetime('now'))`).run(id, safeFilename, fileRelPath, mimetype || getMimeType(safeFilename), stat.size);
      res.json({ ok: true, path: fileRelPath, size: stat.size });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // GET /api/brain/file?path=... — serve/download a file
  app.get('/api/brain/file', (req: Request, res: Response) => {
    try {
      const relPath = String(req.query['path'] ?? '').replace(/\.\./g, '').replace(/^\//, '');
      if (!relPath) return res.status(400).json({ error: 'path required' });
      const absPath = path.join(BRAIN_ROOT, relPath);
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
      res.setHeader('Content-Type', getMimeType(relPath));
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(relPath)}"`);
      res.sendFile(absPath);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // DELETE /api/brain/file?path=... — delete a file or folder
  app.delete('/api/brain/file', (req: Request, res: Response) => {
    try {
      const relPath = String(req.query['path'] ?? '').replace(/\.\./g, '').replace(/^\//, '');
      if (!relPath) return res.status(400).json({ error: 'path required' });
      const absPath = path.join(BRAIN_ROOT, relPath);
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        fs.rmSync(absPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(absPath);
        db.prepare(`DELETE FROM brain_files WHERE path = ?`).run(relPath);
      }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // POST /api/brain/documents — save a document programmatically (used by agents)
  app.post('/api/brain/documents', (req: Request, res: Response) => {
    try {
      const { path: relDir, filename, content, type: docType } = req.body as { path?: string; filename: string; content: string; type?: string };
      if (!filename || content === undefined) return res.status(400).json({ error: 'filename and content required' });
      const safeRelDir = String(relDir ?? '').replace(/\.\./g, '').replace(/^\//, '');
      const safeFilename = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');
      const targetDir = path.join(BRAIN_ROOT, safeRelDir);
      fs.mkdirSync(targetDir, { recursive: true });
      const filePath = path.join(targetDir, safeFilename);
      fs.writeFileSync(filePath, content, 'utf-8');
      const stat = fs.statSync(filePath);
      const fileRelPath = safeRelDir ? `${safeRelDir}/${safeFilename}` : safeFilename;
      const mime = getMimeType(safeFilename);
      const id = `bf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      db.prepare(`INSERT OR REPLACE INTO brain_files (id, name, path, type, mimetype, size, created_at) VALUES (?, ?, ?, 'file', ?, ?, datetime('now'))`).run(id, safeFilename, fileRelPath, mime, stat.size);
      if (docType !== 'binary') {
        db.prepare(`INSERT INTO brain_vault (title, content, type, agent_name, folder_path) VALUES (?, ?, ?, 'Agent', ?)`).run(safeFilename, content.slice(0, 50000), docType || 'document', safeRelDir || 'Documentos');
        const parts = (safeRelDir || 'Documentos').split('/');
        for (let i = 0; i < parts.length; i++) {
          const p = parts.slice(0, i + 1).join('/');
          db.prepare(`INSERT OR IGNORE INTO brain_folders (path, name, parent_path) VALUES (?, ?, ?)`).run(p, parts[i], i > 0 ? parts.slice(0, i).join('/') : null);
        }
      }
      res.json({ ok: true, path: fileRelPath, size: stat.size });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // GET /api/brain/search?q=... — search files by name
  app.get('/api/brain/search', (req: Request, res: Response) => {
    try {
      const q = String(req.query['q'] ?? '').toLowerCase().trim();
      if (!q) return res.json({ items: [] });
      const results: Array<{ name: string; path: string; type: 'file' | 'folder'; size?: number; mimetype?: string }> = [];
      const walk = (relPath: string) => {
        const absPath = path.join(BRAIN_ROOT, relPath);
        if (!fs.existsSync(absPath)) return;
        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
          if (entry.name.toLowerCase().includes(q)) {
            if (entry.isDirectory()) {
              results.push({ name: entry.name, path: entryRel, type: 'folder' });
            } else {
              const stat = fs.statSync(path.join(BRAIN_ROOT, entryRel));
              results.push({ name: entry.name, path: entryRel, type: 'file', size: stat.size, mimetype: getMimeType(entry.name) });
            }
          }
          if (entry.isDirectory()) walk(entryRel);
        }
      };
      walk('');
      res.json({ items: results.slice(0, 50) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // GET /api/brain/recent — recently modified files (last 20)
  app.get('/api/brain/recent', (_req: Request, res: Response) => {
    try {
      const results: Array<{ name: string; path: string; type: 'file' | 'folder'; size?: number; mimetype?: string; modified?: string }> = [];
      const walk = (relPath: string) => {
        const absPath = path.join(BRAIN_ROOT, relPath);
        if (!fs.existsSync(absPath)) return;
        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
          if (!entry.isDirectory()) {
            const stat = fs.statSync(path.join(BRAIN_ROOT, entryRel));
            results.push({ name: entry.name, path: entryRel, type: 'file', size: stat.size, mimetype: getMimeType(entry.name), modified: stat.mtime.toISOString() });
          }
          if (entry.isDirectory()) walk(entryRel);
        }
      };
      walk('');
      results.sort((a, b) => new Date(b.modified!).getTime() - new Date(a.modified!).getTime());
      res.json({ items: results.slice(0, 20) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // GET /api/brain/stats — storage stats
  app.get('/api/brain/stats', (_req: Request, res: Response) => {
    try {
      let totalSize = 0, fileCount = 0, folderCount = 0;
      const walk = (relPath: string) => {
        const absPath = path.join(BRAIN_ROOT, relPath);
        if (!fs.existsSync(absPath)) return;
        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { folderCount++; walk(entryRel); }
          else { fileCount++; const stat = fs.statSync(path.join(BRAIN_ROOT, entryRel)); totalSize += stat.size; }
        }
      };
      walk('');
      res.json({ totalSize, fileCount, folderCount });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // GET /api/brain/tree — folder tree for sidebar
  app.get('/api/brain/tree', (_req: Request, res: Response) => {
    try {
      interface TreeNode { name: string; path: string; children: TreeNode[] }
      const buildTree = (relPath: string): TreeNode[] => {
        const absPath = path.join(BRAIN_ROOT, relPath);
        if (!fs.existsSync(absPath)) return [];
        const entries = fs.readdirSync(absPath, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory());
        return dirs.map(e => {
          const childRel = relPath ? `${relPath}/${e.name}` : e.name;
          return { name: e.name, path: childRel, children: buildTree(childRel) };
        }).sort((a, b) => a.name.localeCompare(b.name));
      };
      res.json({ tree: buildTree('') });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // PATCH /api/brain/rename — rename file or folder { oldPath, newName }
  app.patch('/api/brain/rename', (req: Request, res: Response) => {
    try {
      const { oldPath, newName } = req.body as { oldPath: string; newName: string };
      if (!oldPath || !newName) return res.status(400).json({ error: 'oldPath and newName required' });
      const safeOld = String(oldPath).replace(/\.\./g, '').replace(/^\//, '');
      const safeName = String(newName).replace(/[^a-zA-Z0-9._\- ]/g, '_');
      const absOld = path.join(BRAIN_ROOT, safeOld);
      if (!fs.existsSync(absOld)) return res.status(404).json({ error: 'Not found' });
      const parent = path.dirname(absOld);
      const absNew = path.join(parent, safeName);
      const newRelPath = safeOld.includes('/') ? `${safeOld.split('/').slice(0, -1).join('/')}/${safeName}` : safeName;
      fs.renameSync(absOld, absNew);
      db.prepare(`UPDATE brain_files SET name = ?, path = ?, updated_at = datetime('now') WHERE path = ?`).run(safeName, newRelPath, safeOld);
      res.json({ ok: true, newPath: newRelPath });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // PATCH /api/brain/move — move file or folder { srcPath, destDir }
  app.patch('/api/brain/move', (req: Request, res: Response) => {
    try {
      const { srcPath, destDir } = req.body as { srcPath: string; destDir: string };
      if (!srcPath) return res.status(400).json({ error: 'srcPath required' });
      const safeSrc = String(srcPath).replace(/\.\./g, '').replace(/^\//, '');
      const safeDest = String(destDir ?? '').replace(/\.\./g, '').replace(/^\//, '');
      const absSrc = path.join(BRAIN_ROOT, safeSrc);
      if (!fs.existsSync(absSrc)) return res.status(404).json({ error: 'Not found' });
      const name = path.basename(absSrc);
      const destDirAbs = path.join(BRAIN_ROOT, safeDest);
      fs.mkdirSync(destDirAbs, { recursive: true });
      const absDest = path.join(destDirAbs, name);
      const newRelPath = safeDest ? `${safeDest}/${name}` : name;
      fs.renameSync(absSrc, absDest);
      db.prepare(`UPDATE brain_files SET path = ?, updated_at = datetime('now') WHERE path = ?`).run(newRelPath, safeSrc);
      db.prepare(`UPDATE brain_stars SET path = ? WHERE path = ?`).run(newRelPath, safeSrc);
      res.json({ ok: true, newPath: newRelPath });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // POST /api/brain/star — toggle star on a file/folder
  app.post('/api/brain/star', (req: Request, res: Response) => {
    try {
      const { path: filePath } = req.body as { path: string };
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const safePath = String(filePath).replace(/\.\./g, '').replace(/^\//, '');
      const existing = db.prepare('SELECT path FROM brain_stars WHERE path = ?').get(safePath);
      if (existing) {
        db.prepare('DELETE FROM brain_stars WHERE path = ?').run(safePath);
        res.json({ starred: false });
      } else {
        db.prepare("INSERT OR IGNORE INTO brain_stars (path) VALUES (?)").run(safePath);
        res.json({ starred: true });
      }
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // GET /api/brain/starred — list starred files/folders
  app.get('/api/brain/starred', (_req: Request, res: Response) => {
    try {
      const stars = db.prepare('SELECT path FROM brain_stars ORDER BY created_at DESC').all() as { path: string }[];
      const items: Array<{ name: string; path: string; type: 'file' | 'folder'; size?: number; mimetype?: string; modified?: string; starred: boolean }> = [];
      for (const { path: starPath } of stars) {
        const absPath = path.join(BRAIN_ROOT, starPath);
        if (fs.existsSync(absPath)) {
          const stat = fs.statSync(absPath);
          const name = path.basename(starPath);
          items.push({ name, path: starPath, type: stat.isDirectory() ? 'folder' : 'file', size: stat.isDirectory() ? undefined : stat.size, mimetype: stat.isDirectory() ? undefined : getMimeType(name), modified: stat.mtime.toISOString(), starred: true });
        }
      }
      res.json({ items });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ── GET /api/pipelines ────────────────────────────────────────────
  // Returns scheduled_tasks as pipeline objects for the Pipeline page
  app.get('/api/pipelines', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare(`
        SELECT id, prompt, schedule, status, last_run, next_run, created_at
        FROM scheduled_tasks ORDER BY created_at DESC
      `).all() as Array<Record<string, unknown>>;

      const pipelines = rows.map((row) => {
        const prompt = String(row['prompt'] ?? '');
        const name = prompt.split('.')[0].replace(/^Eres /, '').replace(/^Genera el /, '').trim().slice(0, 60) || 'Scheduled Task';
        const lastRun = row['last_run'] ? new Date(Number(row['last_run']) * 1000).toISOString() : null;
        const nextRun = row['next_run'] ? new Date(Number(row['next_run']) * 1000).toISOString() : null;
        const createdAt = new Date(Number(row['created_at']) * 1000).toISOString();
        return {
          id: row['id'],
          name,
          description: prompt.slice(0, 120) + (prompt.length > 120 ? '…' : ''),
          schedule: row['schedule'],
          status: row['status'] ?? 'active',
          last_run: lastRun,
          next_run: nextRun,
          task_count: 1,
          created_at: createdAt,
          updated_at: lastRun ?? createdAt,
        };
      });

      res.json(pipelines);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/activity/nightly ─────────────────────────────────────
  app.get('/api/activity/nightly', (_req: Request, res: Response) => {
    try {
      const items = db.prepare(
        `SELECT * FROM agent_activity WHERE created_at >= datetime('now', '-12 hours') ORDER BY created_at DESC LIMIT 50`
      ).all();
      res.json({ window: '12h', items });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/costs/llm-stats ──────────────────────────────────────
  app.get('/api/costs/llm-stats', (_req: Request, res: Response) => {
    try {
      const perAgent = db.prepare(`
        SELECT lc.agent_id, COALESCE(a.name, lc.agent_id) as agent_name, lc.model,
          SUM(lc.prompt_tokens) as prompt_tokens, SUM(lc.completion_tokens) as completion_tokens,
          SUM(lc.prompt_tokens + lc.completion_tokens) as total_tokens,
          SUM(lc.cost_usd) as cost_usd, COUNT(*) as calls
        FROM llm_costs lc LEFT JOIN agents a ON a.id = lc.agent_id
        WHERE strftime('%Y-%m', lc.created_at) = strftime('%Y-%m', 'now')
        GROUP BY lc.agent_id, lc.model ORDER BY cost_usd DESC
      `).all();

      const daily = db.prepare(`
        SELECT strftime('%Y-%m-%d', created_at) as date,
               strftime('%Y-%m-%d', created_at) as day,
               SUM(cost_usd) as cost_usd, COUNT(*) as calls
        FROM llm_costs WHERE created_at >= date('now','-30 days')
        GROUP BY date ORDER BY date
      `).all();

      const totals = db.prepare(`
        SELECT COALESCE(SUM(cost_usd),0) as total_cost, COALESCE(SUM(prompt_tokens),0) as prompt_tokens,
          COALESCE(SUM(completion_tokens),0) as completion_tokens, COUNT(*) as calls,
          0 as local_calls, COUNT(*) as cloud_calls
        FROM llm_costs WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now')
      `).get();

      res.json({ perAgent, daily, totals, hasRealData: (perAgent as unknown[]).length > 0 });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/costs/by-agent ───────────────────────────────────────
  app.get('/api/costs/by-agent', (req: Request, res: Response) => {
    try {
      const month = (req.query['month'] as string) || new Date().toISOString().slice(0, 7);
      const data = db.prepare(`
        SELECT lc.agent_id, COALESCE(a.name, lc.agent_id) as agent_name,
          SUM(cost_usd) as cost_usd, COUNT(*) as calls
        FROM llm_costs lc LEFT JOIN agents a ON a.id = lc.agent_id
        WHERE strftime('%Y-%m', lc.created_at) = ?
        GROUP BY lc.agent_id ORDER BY cost_usd DESC
      `).all(month);
      res.json({ status: 'ok', period: month, data });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/agents/run ──────────────────────────────────────────
  // Rate limited (10/min). Enqueues job to sequential in-memory queue.
  app.post('/api/agents/run', (req: Request, res: Response) => {
    const { agent_id, task } = req.body as { agent_id?: string; task?: string };
    if (!agent_id || !task) {
      res.status(400).json({ error: 'agent_id and task are required' });
      return;
    }
    if (typeof task !== 'string' || task.trim().length === 0) {
      res.status(400).json({ error: 'task must be a non-empty string' });
      return;
    }
    if (task.length > 10000) {
      res.status(400).json({ error: 'task exceeds maximum length of 10000 characters' });
      return;
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const job: AgentJob = {
      jobId,
      agent_id,
      task,
      status: 'queued',
      created_at: Date.now(),
    };

    _jobQueue.push(job);
    _jobMap.set(jobId, job);

    // Trim old completed jobs from map (keep last 100)
    if (_jobMap.size > 100) {
      const oldest = Array.from(_jobMap.keys()).slice(0, _jobMap.size - 100);
      for (const k of oldest) _jobMap.delete(k);
    }

    // Kick off processing (no-op if already running)
    void processNextJob();

    res.status(202).json({ ok: true, jobId, status: 'queued', agent_id, task });
  });

  // ── GET /api/agents/run/:jobId ────────────────────────────────────
  app.get('/api/agents/run/:jobId', (req: Request, res: Response) => {
    const job = _jobMap.get(req.params.jobId as string);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      jobId: job.jobId,
      agent_id: job.agent_id,
      status: job.status,
      created_at: job.created_at,
      started_at: job.started_at ?? null,
      finished_at: job.finished_at ?? null,
      error: job.error ?? null,
      queue_position: job.status === 'queued' ? _jobQueue.indexOf(job) + 1 : null,
    });
  });

  // ── GET /api/slow-requests ────────────────────────────────────────
  app.get('/api/slow-requests', (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query['limit']) || 50, 200);
      const rows = db.prepare(
        `SELECT * FROM slow_requests ORDER BY created_at DESC LIMIT ?`
      ).all(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/logs ─────────────────────────────────────────────────
  // Paginated activity logs with optional filters.
  // The aggregate stats (total, byType, byAgent) are cached per filter combination
  // since they're expensive GROUP BY queries and don't vary per page flip.
  app.get('/api/logs', (req: Request, res: Response) => {
    try {
      const limit   = Math.min(Number(req.query['limit'])  || 50,  500);
      const offset  = Math.max(Number(req.query['offset']) || 0,   0);
      const agentId = req.query['agentId']  as string | undefined;
      const type    = req.query['type']     as string | undefined;
      const dept    = req.query['dept']     as string | undefined;
      const search  = req.query['search']   as string | undefined;
      const since   = req.query['since']    as string | undefined; // ISO date

      const conditions: string[] = [];
      const params: SqlBinding[]  = [];

      if (agentId) { conditions.push('agent_id = ?');           params.push(agentId); }
      if (type)    { conditions.push('type = ?');                params.push(type); }
      if (dept)    { conditions.push('department = ?');          params.push(dept); }
      if (search)  { conditions.push('action LIKE ?');           params.push(`%${search}%`); }
      if (since)   { conditions.push('created_at >= ?');         params.push(since); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Cache key for the expensive aggregate queries (total, byType, byAgent).
      // These don't depend on offset/limit so one cache entry covers all pages.
      const aggKey = `logs-agg:${where}:${params.join(',')}`;
      let agg = cacheGet(aggKey) as { total: number; byType: unknown[]; byAgent: unknown[] } | undefined;

      if (!agg) {
        const stmtCount  = db.prepare(`SELECT COUNT(*) as cnt FROM agent_activity ${where}`);
        const stmtByType = db.prepare(`SELECT type, COUNT(*) as cnt FROM agent_activity ${where} GROUP BY type`);
        const stmtByAgt  = db.prepare(`SELECT agent_id, agent_name, COUNT(*) as cnt FROM agent_activity ${where} GROUP BY agent_id ORDER BY cnt DESC LIMIT 10`);

        const total   = (stmtCount.get(...params) as { cnt: number }).cnt;
        const byType  = stmtByType.all(...params);
        const byAgent = stmtByAgt.all(...params);
        agg = { total, byType, byAgent };
        cacheSet(aggKey, agg, 8_000); // 8s TTL aligns with activity cache
      }

      const stmtRows = db.prepare(`SELECT * FROM agent_activity ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`);
      const rows = stmtRows.all(...params, limit, offset);

      res.json({ total: agg.total, offset, limit, rows, byType: agg.byType, byAgent: agg.byAgent });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/system-health ────────────────────────────────────────
  // Aggregated system health: uptime, DB stats, slow request summary, agent status.
  // DB-heavy data cached for 10s. Uptime/memory always fresh.
  app.get('/api/system-health', (_req: Request, res: Response) => {
    try {
      const uptimeSeconds = process.uptime();
      const memUsage      = process.memoryUsage();

      const cachedDb = cacheGet('system-health-db') as {
        agents: unknown; tasks: unknown; logs: unknown; llm: unknown; slow_requests: unknown
      } | undefined;

      let dbPayload: typeof cachedDb;

      if (cachedDb) {
        dbPayload = cachedDb;
      } else {
        // ── Batch 1: agent + task + cost totals in one round-trip ────────
        const totals = db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM agents)                                      as totalAgents,
            (SELECT COUNT(*) FROM agents WHERE status IN ('active','working')) as activeAgents,
            (SELECT COUNT(*) FROM agent_tasks)                                 as totalTasks,
            (SELECT COUNT(*) FROM llm_costs)                                   as totalCostCalls
        `).get() as { totalAgents: number; activeAgents: number; totalTasks: number; totalCostCalls: number };

        // ── Batch 2: all activity stats in one round-trip ─────────────────
        const actRow = db.prepare(`
          SELECT
            COUNT(*)                                                                         as totalLogs,
            SUM(CASE WHEN created_at >= datetime('now','-1 hour')   THEN 1 ELSE 0 END)      as logsLastHour,
            SUM(CASE WHEN created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END)      as logsLast24h
          FROM agent_activity
        `).get() as { totalLogs: number; logsLastHour: number; logsLast24h: number };

        // ── Batch 3: all slow-request stats in one round-trip ─────────────
        const slowRow = db.prepare(`
          SELECT
            COUNT(*)                                                                             as slowReqTotal,
            SUM(CASE WHEN created_at >= datetime('now','-24 hours') THEN 1 ELSE 0 END)          as slowReqLast24h,
            COALESCE(AVG(CASE WHEN created_at >= datetime('now','-24 hours') THEN duration_ms END), 0) as avgDuration,
            COALESCE(MAX(CASE WHEN created_at >= datetime('now','-24 hours') THEN duration_ms END), 0) as maxDuration
          FROM slow_requests
        `).get() as { slowReqTotal: number; slowReqLast24h: number; avgDuration: number; maxDuration: number };

        const hourlyActivity = db.prepare(`
          SELECT strftime('%H:00', created_at) as hour, COUNT(*) as cnt
          FROM agent_activity WHERE created_at >= datetime('now','-24 hours')
          GROUP BY hour ORDER BY hour
        `).all();

        const topSlow = db.prepare(`
          SELECT method, path, status_code, duration_ms, created_at
          FROM slow_requests ORDER BY created_at DESC LIMIT 10
        `).all();

        dbPayload = {
          agents: { total: totals.totalAgents, active: totals.activeAgents, idle: totals.totalAgents - totals.activeAgents },
          tasks:  { total: totals.totalTasks },
          logs:   { total: actRow.totalLogs, last_1h: actRow.logsLastHour, last_24h: actRow.logsLast24h, hourly: hourlyActivity },
          llm:    { total_calls: totals.totalCostCalls },
          slow_requests: {
            total: slowRow.slowReqTotal,
            last_24h: slowRow.slowReqLast24h,
            avg_duration_ms: Math.round(slowRow.avgDuration),
            max_duration_ms: slowRow.maxDuration,
            recent: topSlow,
          },
        };
        cacheSet('system-health-db', dbPayload, 10_000); // 10s TTL
      }

      res.json({
        server: {
          status: 'online',
          uptime_seconds: Math.round(uptimeSeconds),
          uptime_human: formatUptime(uptimeSeconds),
          port: PORT,
          node_version: process.version,
          memory_rss_mb: Math.round(memUsage.rss / 1024 / 1024),
          memory_heap_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
          db_path: DB_PATH,
          timestamp: new Date().toISOString(),
        },
        ...dbPayload,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /health ───────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // ── OAUTH ─────────────────────────────────────────────────────────
  app.get('/api/oauth/:provider', (req: Request, res: Response) => {
    try {
      const provider = req.params['provider'] as string;
      const ALLOWED_PROVIDERS = ['gmail', 'google', 'notion', 'github', 'slack'];
      if (!ALLOWED_PROVIDERS.includes(provider)) {
        res.status(400).json({ error: 'Unknown provider' });
        return;
      }
      const row = db.prepare(`SELECT * FROM oauth_tokens WHERE provider = ?`).get(provider) as any;
      if (!row) { res.json({ provider, is_active: false, account_email: null, token_expiry: null, last_sync_at: null }); return; }
      // Never expose the raw access token in API responses
      res.json({ provider: row.provider, is_active: true, account_email: row.account_email, token_expiry: row.token_expiry, last_sync_at: row.last_sync_at });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/oauth/:provider', (req: Request, res: Response) => {
    try {
      const providerPost = req.params['provider'] as string;
      const ALLOWED_PROVIDERS = ['gmail', 'google', 'notion', 'github', 'slack'];
      if (!ALLOWED_PROVIDERS.includes(providerPost)) {
        res.status(400).json({ error: 'Unknown provider' });
        return;
      }
      const body = req.body as any;
      const access_token = body.access_token ?? body.accessToken;
      const token_expiry = body.token_expiry ?? body.tokenExpiry ?? null;
      const account_email = body.account_email ?? body.accountEmail ?? null;
      if (!access_token) { res.status(400).json({ error: 'access_token required' }); return; }
      db.prepare(`
        INSERT INTO oauth_tokens (provider, access_token, token_expiry, account_email, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(provider) DO UPDATE SET
          access_token = excluded.access_token,
          token_expiry = excluded.token_expiry,
          account_email = excluded.account_email,
          updated_at = datetime('now')
      `).run(providerPost, access_token, token_expiry, account_email);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/oauth/:provider', (req: Request, res: Response) => {
    try {
      const providerDel = req.params['provider'] as string;
      const ALLOWED_PROVIDERS = ['gmail', 'google', 'notion', 'github', 'slack'];
      if (!ALLOWED_PROVIDERS.includes(providerDel)) {
        res.status(400).json({ error: 'Unknown provider' });
        return;
      }
      db.prepare(`DELETE FROM oauth_tokens WHERE provider = ?`).run(providerDel);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/oauth/:provider/sync', (req: Request, res: Response) => {
    try {
      const providerSync = req.params['provider'] as string;
      const ALLOWED_PROVIDERS = ['gmail', 'google', 'notion', 'github', 'slack'];
      if (!ALLOWED_PROVIDERS.includes(providerSync)) {
        res.status(400).json({ error: 'Unknown provider' });
        return;
      }
      db.prepare(`UPDATE oauth_tokens SET last_sync_at = datetime('now') WHERE provider = ?`).run(providerSync);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── SLACK CONNECT ────────────────────────────────────────────────
  // Save a Slack User OAuth Token to the DB and write it to .env
  app.post('/api/slack/connect', async (req: Request, res: Response) => {
    try {
      const { token, workspace } = req.body as { token?: string; workspace?: string };
      if (!token || !token.startsWith('xoxp-')) {
        res.status(400).json({ error: 'Invalid token. Must be a Slack User OAuth Token starting with xoxp-' });
        return;
      }

      // Validate token against Slack API
      const authTest = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const authData = await authTest.json() as { ok: boolean; team?: string; user?: string; error?: string };
      if (!authData.ok) {
        res.status(400).json({ error: `Slack rejected token: ${authData.error}` });
        return;
      }

      const workspaceName = workspace || authData.team || 'Slack';
      const slackUser = authData.user || 'unknown';

      // Save to oauth_tokens
      db.prepare(`
        INSERT INTO oauth_tokens (provider, access_token, account_email, updated_at)
        VALUES ('slack', ?, ?, datetime('now'))
        ON CONFLICT(provider) DO UPDATE SET
          access_token = excluded.access_token,
          account_email = excluded.account_email,
          updated_at = datetime('now')
      `).run(token, `${slackUser}@${workspaceName}`);

      // Write to .env
      const envPath = path.join(__dirname, '..', '.env');
      let envContent = fs.readFileSync(envPath, 'utf-8');
      if (envContent.includes('SLACK_USER_TOKEN=')) {
        envContent = envContent.replace(/^SLACK_USER_TOKEN=.*/m, `SLACK_USER_TOKEN=${token}`);
      } else {
        envContent += `\n# ── Slack ─────────────────────────────────────────────────────────────────────\nSLACK_USER_TOKEN=${token}\n`;
      }
      fs.writeFileSync(envPath, envContent, 'utf-8');

      // Also update process.env so the running process can use it immediately
      process.env['SLACK_USER_TOKEN'] = token;

      // Log activity
      db.prepare(`INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','Slack conectado — workspace: ${workspaceName}','success','executive',datetime('now'))`).run();

      res.json({ ok: true, workspace: workspaceName, user: slackUser });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Disconnect Slack — remove from DB and .env
  app.delete('/api/slack/connect', (req: Request, res: Response) => {
    try {
      db.prepare(`DELETE FROM oauth_tokens WHERE provider = 'slack'`).run();

      const envPath = path.join(__dirname, '..', '.env');
      let envContent = fs.readFileSync(envPath, 'utf-8');
      envContent = envContent.replace(/# ── Slack ──[^\n]*\n?/g, '');
      envContent = envContent.replace(/^SLACK_USER_TOKEN=.*\n?/m, '');
      fs.writeFileSync(envPath, envContent, 'utf-8');

      delete process.env['SLACK_USER_TOKEN'];

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── RECORDINGS ────────────────────────────────────────────────────
  // Ensure recordings table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT,
      transcript TEXT,
      minuta TEXT,
      summary TEXT,
      duration_secs INTEGER,
      filename TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Ensure recordings table has action_items column
  try { db.exec(`ALTER TABLE recordings ADD COLUMN action_items TEXT`); } catch (_) {}
  // Ensure recordings table has meeting_type column
  try { db.exec(`ALTER TABLE recordings ADD COLUMN meeting_type TEXT DEFAULT 'general'`); } catch (_) {}

  // Ensure agent_meetings has transcript/notes/summary columns
  try { db.exec(`ALTER TABLE agent_meetings ADD COLUMN transcript TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE agent_meetings ADD COLUMN notes TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE agent_meetings ADD COLUMN summary TEXT`); } catch (_) {}
  // Ensure meeting_live_notes has type column (note / action_item / decision / risk)
  try { db.exec(`ALTER TABLE meeting_live_notes ADD COLUMN type TEXT DEFAULT 'note'`); } catch (_) {}

  // Ensure live_recordings table exists (for real-time Web Speech API recording sessions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_recordings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Meeting',
      status TEXT NOT NULL DEFAULT 'recording',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      transcript TEXT NOT NULL DEFAULT '',
      live_summary TEXT NOT NULL DEFAULT '',
      live_minutes TEXT NOT NULL DEFAULT '',
      live_tasks TEXT NOT NULL DEFAULT '[]',
      participants TEXT NOT NULL DEFAULT '[]',
      document_path TEXT,
      meeting_id TEXT,
      meeting_type TEXT NOT NULL DEFAULT 'general',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Ensure live_recordings has meeting_type column (migration guard)
  try { db.exec(`ALTER TABLE live_recordings ADD COLUMN meeting_type TEXT DEFAULT 'general'`); } catch (_) {}

  // Ensure pending_email_followups table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_email_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT NOT NULL,
      document_path TEXT NOT NULL,
      asked_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Ensure meeting_email_log table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id INTEGER,
      meeting_id TEXT,
      email TEXT NOT NULL,
      sent_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'sent',
      sent_by TEXT DEFAULT 'auto'
    )
  `);

  // ── PHONE CALLS ───────────────────────────────────────────────────────────────
  // GET /api/calls — list all phone calls (from `calls` table, Vapi-driven)
  app.get('/api/calls', (req: Request, res: Response) => {
    try {
      // Auto-cleanup: mark any call stuck in active state for >10min as completed (missed webhook or test data)
      // Throttled to at most once per 60s — the page polls every 2s, running heavy UPDATE queries on every
      // poll was the primary cause of slow page loads. Stale cleanup doesn't need sub-minute precision.
      const nowMs = Date.now();
      if (nowMs - _lastStaleCleanup > 60_000) {
        _lastStaleCleanup = nowMs;
        const staleCleanup = db.prepare(`
          UPDATE calls
          SET status = 'completed',
              ended_reason = COALESCE(ended_reason, 'stale-cleanup'),
              outcome = COALESCE(outcome, 'failed'),
              ended_at = COALESCE(ended_at, datetime('now'))
          WHERE status IN ('in_progress', 'queued')
            AND (ended_at IS NULL OR ended_at = '')
            AND created_at < datetime('now', '-10 minutes')
        `).run();
        // Deduplication: close any in_progress call for a number that already has a newer completed record
        db.prepare(`
          UPDATE calls SET status = 'completed', ended_reason = 'duplicate-dedup', ended_at = COALESCE(ended_at, datetime('now'))
          WHERE status IN ('in_progress', 'queued')
            AND to_number != ''
            AND to_number IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM calls c2
              WHERE c2.to_number = calls.to_number
                AND c2.status = 'completed'
                AND c2.created_at > calls.created_at
            )
        `).run();
        // If stale calls were cleaned up and no active calls remain, reset Thorn's status
        if (staleCleanup.changes > 0) {
          const activeCallCount = (db.prepare(`SELECT COUNT(*) as cnt FROM calls WHERE status IN ('in_progress', 'queued') AND (ended_at IS NULL OR ended_at = '')`).get() as { cnt: number })?.cnt ?? 0;
          if (activeCallCount === 0) {
            db.prepare(`UPDATE agents SET status = 'active', current_task = NULL, updated_at = unixepoch() WHERE id = 'thorn' AND status = 'working'`).run();
          }
        }
      }

      const limit = Math.min(Number((req.query as Record<string, string>)['limit']) || 50, 100);
      const status = (req.query as Record<string, string>)['status'];
      let query = `SELECT * FROM calls`;
      const params: SqlBinding[] = [];
      if (status && status !== 'all') {
        query += ` WHERE status = ?`;
        params.push(status);
      }
      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
      // Normalize for frontend: map to consistent field names
      const normalized = rows.map(r => ({
        id: r['id'],
        contact_name: r['contact_name'] || r['to_number'] || 'Unknown',
        contact_phone: r['to_number'] || '',
        objective: r['objective'] || '',
        status: (() => {
          const s = r['status'] as string;
          const er = r['ended_reason'] as string | undefined;
          if (s === 'queued') return 'in-progress';
          if (s === 'completed' || s === 'answered') {
            if (er === 'voicemail') return 'voicemail';
            if (er && ['no-answer','customer-did-not-answer','busy','silence-timed-out'].includes(er)) return 'missed';
            return 'answered';
          }
          return s;
        })(),
        objective_achieved: r['objective_achieved'] != null ? Boolean(r['objective_achieved']) : null,
        duration_secs: r['duration_seconds'] ?? null,
        started_at: r['started_at'] || r['created_at'],
        ended_at: r['ended_at'] ?? null,
        transcript: r['transcript'] ?? null,
        notes: r['outcome'] ?? null,
        vapi_call_id: r['vapi_call_id'],
        ended_reason: r['ended_reason'],
        // Extended fields for calls page UI
        outcome: r['outcome'] ?? null,
        summary: r['summary'] ?? null,
        accuracy_score: r['accuracy_score'] != null ? Number(r['accuracy_score']) : null,
        direction: (r['direction'] as string | undefined) ?? 'outbound',
        cost_usd: r['cost_usd'] != null ? Number(r['cost_usd']) : null,
      }));
      res.json(normalized);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/calls/stats — aggregate stats from calls table
  app.get('/api/calls/stats', (_req: Request, res: Response) => {
    try {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today,
          SUM(CASE WHEN status IN ('answered','completed') THEN 1 ELSE 0 END) as answered_count,
          SUM(CASE WHEN ended_reason IN ('customer-did-not-answer','no-answer','busy') THEN 1 ELSE 0 END) as missed_count,
          SUM(CASE WHEN ended_reason IN ('voicemail') THEN 1 ELSE 0 END) as voicemail_count,
          SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partial_count,
          SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) as failed_count,
          SUM(CASE WHEN objective_achieved = 1 THEN 1 ELSE 0 END) as achieved_count,
          AVG(CASE WHEN duration_seconds > 0 THEN duration_seconds ELSE NULL END) as avg_duration,
          AVG(CASE WHEN accuracy_score IS NOT NULL THEN accuracy_score ELSE NULL END) as avg_accuracy,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN cost_usd ELSE 0 END), 0) as cost_this_month,
          COALESCE(SUM(CASE WHEN date(created_at) = date('now') THEN cost_usd ELSE 0 END), 0) as cost_today,
          COALESCE(SUM(duration_seconds), 0) as total_duration_seconds
        FROM calls
      `).get() as Record<string, unknown>;
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PATCH /api/calls/:id — update call record
  app.patch('/api/calls/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const fields = req.body as Record<string, unknown>;
      const allowed = ['status', 'outcome', 'duration_seconds', 'transcript', 'objective_achieved', 'ended_at', 'ended_reason', 'cost_usd', 'summary', 'accuracy_score'];
      const updates = Object.entries(fields)
        .filter(([k]) => allowed.includes(k))
        .map(([k]) => `${k} = ?`);
      if (updates.length === 0) { res.status(400).json({ error: 'No valid fields' }); return; }
      const values = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([, v]) => v as string | number | null);
      db.prepare(`UPDATE calls SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // DELETE /api/calls/:id — remove a call record from history
  app.delete('/api/calls/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      // Also delete transcript turns for this call
      db.prepare(`DELETE FROM call_transcripts WHERE call_id = ?`).run(id);
      const result = db.prepare(`DELETE FROM calls WHERE id = ?`).run(id);
      if (result.changes === 0) return res.status(404).json({ error: 'Call not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/calls — log a new call (called when make_call is triggered)
  app.post('/api/calls', (req: Request, res: Response) => {
    try {
      const { vapi_call_id, to_number, contact_name, objective, started_at, task_id } = req.body as Record<string, string>;
      const id = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const resolvedName = contact_name || to_number;
      db.prepare(`
        INSERT INTO calls (id, vapi_call_id, to_number, contact_name, objective, status, started_at, task_id, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, datetime('now'))
      `).run(id, vapi_call_id || null, to_number, resolvedName, objective || '', started_at || new Date().toISOString(), task_id || null);
      // Log to activity feed so calls appear in dashboard
      db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, 'call', 'executive', datetime('now'))`).run(`Llamada iniciada a ${resolvedName}${objective ? ` — ${objective.slice(0, 60)}` : ''}`);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/calls/:id — single call with full transcript
  app.get('/api/calls/:id', (req: Request, res: Response) => {
    try {
      const call = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(req.params['id'] as string);
      if (!call) return res.status(404).json({ error: 'Call not found' });
      res.json(call);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/calls/:id/transcripts — live + historical transcript turns for a call
  app.get('/api/calls/:id/transcripts', (req: Request, res: Response) => {
    try {
      const callId = req.params['id'] as string;
      const turns = db.prepare(
        `SELECT * FROM call_transcripts WHERE call_id = ? ORDER BY id ASC`
      ).all(callId);
      res.json(turns);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Vapi webhook secret verification helper ───────────────────────────────
  // Vapi sends the server.secret as a Bearer token in the Authorization header
  // or as X-Vapi-Secret for legacy configs.
  // Returns true if the request matches our stored secret, or if no secret configured (open mode).
  function verifyVapiSignature(req: Request): boolean {
    const secret = process.env['VAPI_WEBHOOK_SECRET'] ?? '';
    if (!secret) return true; // Secret not set — allow all (open/dev mode)

    // Check Authorization: Bearer {secret}
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token === secret) return true;
    }

    // Check X-Vapi-Secret (legacy header)
    const vapiSecret = req.headers['x-vapi-secret'] as string | undefined;
    if (vapiSecret && vapiSecret === secret) return true;

    // Check x-vapi-signature (HMAC variant — used if serverUrlSecret is set on Vapi phone number)
    const signature = req.headers['x-vapi-signature'] as string | undefined;
    if (signature) {
      try {
        
        // Use raw body bytes for accurate HMAC — falls back to re-serialized JSON
        const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
        const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
        // Support both hex and base64 encoded signatures from Vapi
        if (signature.length === expected.length) {
          try {
            return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
          } catch { /* not hex */ }
        }
        // Try base64 comparison
        const expectedB64 = createHmac('sha256', secret).update(rawBody).digest('base64');
        if (signature === expectedB64) return true;
      } catch { /* fall through */ }
    }

    // If no signature headers at all and secret is configured, allow through
    // (Vapi may not sign when no serverUrlSecret is configured on the phone number)
    const hasNoAuthHeaders = !req.headers['authorization'] && !req.headers['x-vapi-secret'] && !signature;
    if (hasNoAuthHeaders) {
      logger.warn('[vapi-webhook] No auth headers from Vapi — allowing through (check serverUrlSecret config)');
      return true;
    }

    logger.warn('[vapi-webhook] Secret mismatch — rejecting request');
    return false;
  }

  // ── Caller identity security helper ───────────────────────────────────────
  // Returns {allowed, known, isOwner} based on the VAPI_ALLOWED_CALLERS whitelist
  // and the OWNER_VERIFIED_PHONE env var.
  // isOwner = true only when the caller number exactly matches OWNER_VERIFIED_PHONE.
  function checkCallerIdentity(callerNumber: string): { allowed: boolean; known: boolean; name: string | null; isGonzalo: boolean } {
    if (!callerNumber) return { allowed: true, known: false, name: null, isGonzalo: false };
    const cleanNumber = callerNumber.replace(/[\s\-().]/g, '');

    // Check if this is the owner's verified number
    const ownerPhone = (process.env['OWNER_VERIFIED_PHONE'] ?? process.env['GONZALO_VERIFIED_PHONE'] ?? '').replace(/[\s\-().]/g, '');
    const ownerName = process.env['OWNER_NAME'] || 'the owner';
    const isGonzalo = !!ownerPhone && (
      cleanNumber === ownerPhone ||
      cleanNumber.endsWith(ownerPhone.slice(-10)) ||
      ownerPhone.endsWith(cleanNumber.slice(-10))
    );

    // Look up in contacts
    const contact = db.prepare(
      `SELECT name FROM contacts WHERE replace(replace(replace(phone,' ',''),'-',''),'.','') = ? OR replace(replace(replace(phone,' ',''),'-',''),'.','') LIKE ? LIMIT 1`
    ).get(cleanNumber, `%${cleanNumber.slice(-10)}`) as { name: string } | undefined;
    // If caller is the owner, use their configured name as display name
    const name = isGonzalo ? ownerName : (contact?.name ?? null);

    const allowedList = (process.env['VAPI_ALLOWED_CALLERS'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowedList.length === 0) {
      // No whitelist configured — allow all callers
      return { allowed: true, known: !!contact || isGonzalo, name, isGonzalo };
    }
    const isAllowed = isGonzalo || allowedList.some(n => {
      const cleanAllowed = n.replace(/[\s\-().]/g, '');
      return cleanAllowed === cleanNumber || cleanNumber.endsWith(cleanAllowed.slice(-10));
    });
    return { allowed: isAllowed, known: !!contact || isGonzalo, name, isGonzalo };
  }

  // ── Call-ended voice notification helpers ────────────────────────────────

  /** Use GPT-4o-mini to summarise a call transcript into 1-2 plain sentences. */
  async function summarizeCallTranscript(transcript: string, contactName: string, objective: string): Promise<string> {
    const openaiKey = process.env['OPENAI_API_KEY'] ?? '';
    if (!openaiKey || transcript.length < 50) return '';
    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 120,
          messages: [
            { role: 'system', content: 'Resume esta llamada en 1-2 oraciones en español. Sé directo: qué se acordó, qué respondieron, cuál fue el resultado concreto. Sin preámbulos.' },
            { role: 'user', content: `Llamada con: ${contactName}\nObjetivo: ${objective}\n\nTranscripción:\n${transcript.slice(0, 3000)}` }
          ]
        })
      });
      if (!resp.ok) return '';
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() ?? '';
    } catch { return ''; }
  }

  /** Synthesise text to speech using ElevenLabs. Returns null on any failure. */
  async function synthesizeForCall(text: string): Promise<Buffer | null> {
    const apiKey = process.env['ELEVENLABS_API_KEY'] ?? '';
    const voiceId = process.env['ELEVENLABS_VOICE_ID'] ?? '';
    if (!apiKey || !voiceId || !text) return null;
    try {
      const safe = text.length > 2500 ? text.slice(0, 2500) : text;
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text: safe, model_id: 'eleven_turbo_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
      });
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      return Buffer.from(buf);
    } catch { return null; }
  }

  /** Send an audio buffer to Telegram as a voice note. */
  async function sendTelegramVoiceNote(botToken: string, chatId: string, audioBuffer: Buffer): Promise<void> {
    const boundary = `----TgVoiceBoundary${Date.now()}`;
    const parts: Buffer[] = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="summary.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(parts);
    await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
      body,
    });
  }

  /**
   * Full call-ended notification — routed through the real Thorn pipeline.
   *
   * Primary path: POST transcript to thorn-bot's inject endpoint so Thorn
   * (Claude) can process it with full context, take follow-up actions, and
   * reply in voice just like any other message.
   *
   * Fallback path (if thorn-bot is unreachable): GPT-4o-mini summary → TTS →
   * voice note. Double fallback: text message.
   */
  async function notifyCallEnded(opts: {
    botToken: string; chatId: string; contactName: string; objective: string;
    durationSeconds: number; callSummary: string; transcript: string; logPrefix: string;
  }): Promise<void> {
    const { botToken, chatId, contactName, objective, durationSeconds, callSummary, transcript, logPrefix } = opts;
    const durationFmt = durationSeconds > 0 ? ` (${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')})` : '';
    const fallbackText = `Llamada con ${contactName} terminada${durationFmt} — ${callSummary}`;

    // ── Proactive shared-memory write (unconditional) ────────────────────────
    // Always persist the call to the shared memory pool BEFORE any notification
    // path runs. This guarantees Telegram, glasses, and future calls can all
    // reference the conversation regardless of whether inject or fallback fires.
    try {
      const gonzaloChatIdPre = process.env['ALLOWED_CHAT_ID'] ?? '';
      if (gonzaloChatIdPre) {
        const nowPre = Math.floor(Date.now() / 1000);
        // Save summary/fact as episodic memory — searchable via FTS
        const memContentPre = `Llamada con ${contactName}${durationFmt}: ${callSummary || transcript.slice(0, 300)}`;
        db.prepare('INSERT INTO memories (chat_id, content, sector, source, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(gonzaloChatIdPre, memContentPre, 'episodic', 'vapi', nowPre, nowPre);
        // Save full transcript to conversation_log for deep context retrieval
        if (transcript && transcript.length >= 50) {
          db.prepare('INSERT INTO conversation_log (chat_id, session_id, role, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(gonzaloChatIdPre, null, 'user', `[Llamada con ${contactName}${durationFmt}]: ${transcript.slice(0, 8000)}`, 'vapi', nowPre);
          if (callSummary) {
            db.prepare('INSERT INTO conversation_log (chat_id, session_id, role, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
              .run(gonzaloChatIdPre, null, 'assistant', `Resumen: ${callSummary}`, 'vapi', nowPre);
          }
        }
        logger.info({ logPrefix }, '[notifyCallEnded] Call transcript proactively saved to shared memory pool');
      }
    } catch (preMemErr) {
      logger.warn({ err: preMemErr }, '[notifyCallEnded] Failed to pre-save call to shared memory');
    }

    // ── Primary: inject into real Thorn pipeline ────────────────────────────
    const BOT_INJECT_PORT = parseInt(process.env['BOT_INJECT_PORT'] ?? '3142', 10);
    if (transcript && transcript.length >= 50) {
      try {
        const injectionMessage = `[Voice transcribed]: Llamada terminada con ${contactName}${durationFmt}. Objetivo: ${objective || 'N/A'}.

Transcripción completa:
${transcript.slice(0, 8000)}

Resumen de Vapi: ${callSummary || 'N/A'}

Procesa esta llamada: resume qué pasó, qué se acordó, y qué sigue (si hay algo que hacer). Responde como nota de voz.`;

        const injectResp = await fetch(`http://127.0.0.1:${BOT_INJECT_PORT}/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: injectionMessage, voice: true }),
          signal: AbortSignal.timeout(5000), // 5s to confirm receipt — processing is async
        });

        if (injectResp.ok) {
          logger.info({ logPrefix }, '[notifyCallEnded] Transcript routed to Thorn pipeline via inject endpoint');
          return; // thorn-bot takes it from here
        }
        logger.warn({ status: injectResp.status, logPrefix }, '[notifyCallEnded] inject endpoint returned non-OK — falling back');
      } catch (injectErr) {
        logger.warn({ err: injectErr, logPrefix }, '[notifyCallEnded] inject endpoint unreachable — falling back to direct path');
      }
    }

    // ── Fallback: direct GPT-4o-mini + TTS path ─────────────────────────────
    // Memory was already written unconditionally above — no duplicate write needed here.

    try {
      if (transcript && transcript.length >= 50) {
        const summary = await summarizeCallTranscript(transcript, contactName, objective);
        if (summary) {
          const audio = await synthesizeForCall(summary);
          if (audio) {
            await sendTelegramVoiceNote(botToken, chatId, audio);
            return;
          }
          // TTS failed — send text summary
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: summary }),
          });
          return;
        }
      }
      // No transcript or summary failed — send basic status
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: fallbackText }),
      });
    } catch (err) {
      logger.warn({ err }, `[${logPrefix}] failed to send call-ended notification`);
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: fallbackText }),
        });
      } catch (_) { /* give up */ }
    }
  }

  // ── Telegram alert helper for inbound calls ───────────────────────────────
  async function alertInboundCall(callerDisplay: string, allowed: boolean): Promise<void> {
    const botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
    const chatId = process.env['ALLOWED_CHAT_ID'] ?? '';
    if (!botToken || !chatId) return;
    const emoji = allowed ? 'Llamada entrante' : 'LLAMADA BLOQUEADA';
    const msg = allowed
      ? `${emoji} de ${callerDisplay}. Thorn esta respondiendo.`
      : `${emoji} de ${callerDisplay}. Numero no esta en la lista permitida — llamada rechazada.`;
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
    } catch (e) {
      logger.warn({ e }, '[vapi] Failed to send Telegram alert for inbound call');
    }
  }

  // POST /api/telegram-webhook — Telegram Bot webhook receiver
  // Receives updates from Telegram when the bot runs in webhook mode.
  // Forwards the incoming message to thorn-bot via the inject server (port 3142).
  app.post('/api/telegram-webhook', async (req: Request, res: Response) => {
    try {
      res.status(200).json({ ok: true }); // Acknowledge immediately to avoid Telegram retries
      const update = req.body as Record<string, unknown>;
      const message = (update['message'] ?? update['edited_message']) as Record<string, unknown> | undefined;
      if (!message) return;

      const chatId = (message['chat'] as Record<string, unknown> | undefined)?.['id'];
      const allowedChatId = process.env['ALLOWED_CHAT_ID'] ?? '';
      if (allowedChatId && String(chatId) !== String(allowedChatId)) {
        logger.warn({ chatId }, '[telegram-webhook] Message from unauthorized chat — ignored');
        return;
      }

      // Extract text or voice transcription
      let text = (message['text'] as string | undefined) ?? '';
      const isVoice = !!(message['voice'] || message['audio']);

      if (!text && !isVoice) return;

      const BOT_INJECT_PORT_TG = parseInt(process.env['BOT_INJECT_PORT'] ?? '3142', 10);
      try {
        await fetch(`http://127.0.0.1:${BOT_INJECT_PORT_TG}/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, voice: isVoice }),
          signal: AbortSignal.timeout(5000),
        });
        logger.info({ chatId }, '[telegram-webhook] Update forwarded to thorn-bot inject endpoint');
      } catch (injectErr) {
        logger.warn({ err: injectErr }, '[telegram-webhook] Failed to forward to inject endpoint');
      }
    } catch (err) {
      logger.error({ err }, '[telegram-webhook] Error processing update');
    }
  });

  // POST /api/calls/vapi-webhook — Vapi call lifecycle webhook (call-started, call-ended)
  app.post('/api/calls/vapi-webhook', (req: Request, res: Response) => {
    function detectObjectiveAchieved(transcript: string): number {
      if (!transcript) return 0;
      const lower = transcript.toLowerCase();
      const negative = ['buzón', 'buzon', 'silence-timed-out', 'no contesto', 'no contestó', 'no disponible'];
      if (negative.some(w => lower.includes(w))) return 0;
      const positive = ['sí,', 'si,', 'claro', 'perfecto', 'de acuerdo', 'está bien', 'listo', 'okay', 'ok,'];
      return positive.some(w => lower.includes(w)) ? 1 : 0;
    }
    try {
      // ── HMAC signature verification ────────────────────────────────
      if (!verifyVapiSignature(req)) {
        logger.warn('[vapi-webhook] Invalid or missing signature — request rejected');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const message = (body['message'] as Record<string, unknown> | undefined) ?? body;
      const eventType = (message['type'] as string | undefined) ?? (body['type'] as string | undefined) ?? '';
      const callObj = (message['call'] as Record<string, unknown> | undefined) ?? {};
      const vapiCallId = (callObj['id'] as string | undefined) ?? (body['call_id'] as string | undefined) ?? '';
      logger.info({ eventType, vapiCallId }, '[vapi-webhook] call event received');
      if (!vapiCallId) { res.json({ ok: true }); return; }
      const existing = db.prepare(`SELECT * FROM calls WHERE vapi_call_id = ?`).get(vapiCallId) as Record<string, unknown> | undefined;
      if (eventType === 'call-started') {
        const startedAt = (callObj['startedAt'] as string | undefined) ?? new Date().toISOString();
        // Detect direction: inbound calls have call.type === 'inboundPhoneCall'
        const callType = (callObj['type'] as string | undefined) ?? '';
        const isInbound = callType === 'inboundPhoneCall' || (!existing && callType !== 'outboundPhoneCall');
        const direction = isInbound ? 'inbound' : 'outbound';
        const customer = (callObj['customer'] as Record<string, unknown> | undefined) ?? {};
        const callerNumber = (customer['number'] as string | undefined) ?? '';

        // ── Caller identity security check (inbound only) ───────────
        // Always run checkCallerIdentity so we get isGonzalo + contact name
        const inboundIdentity = (isInbound && callerNumber) ? checkCallerIdentity(callerNumber) : null;
        if (inboundIdentity) {
          const callerDisplay = inboundIdentity.name ?? callerNumber;
          logger.info({ callerNumber, allowed: inboundIdentity.allowed, known: inboundIdentity.known, isGonzalo: inboundIdentity.isGonzalo }, '[vapi-webhook] inbound caller check');
          // Always log the inbound call attempt
          db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, ?, 'executive', datetime('now'))`).run(
            `Llamada entrante${inboundIdentity.isGonzalo ? ' de Gonzalo (verificado)' : inboundIdentity.known ? ' (conocido)' : ' (desconocido)'}: ${callerDisplay}`,
            inboundIdentity.allowed ? 'info' : 'warning'
          );
          // Fire Telegram alert asynchronously
          void alertInboundCall(callerDisplay, inboundIdentity.allowed);
          if (!inboundIdentity.allowed) {
            logger.warn({ callerNumber }, '[vapi-webhook] Caller not in whitelist — blocking call');
            // Still accept Vapi webhook but mark call as blocked
            const blockedId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            db.prepare(`INSERT INTO calls (id, vapi_call_id, to_number, contact_name, objective, direction, status, caller_allowed, started_at, created_at) VALUES (?, ?, ?, ?, 'Llamada entrante bloqueada', 'inbound', 'blocked', 0, ?, datetime('now'))`).run(blockedId, vapiCallId, callerNumber, callerDisplay, startedAt);
            cacheInvalidate('calls');
            // Return instruction to hang up — Vapi will end call if we say so
            res.json({ ok: true, action: 'hangup' });
            return;
          }
        }

        if (existing) {
          // Only update status to in_progress if the call hasn't already been completed/missed
          db.prepare(`UPDATE calls SET status = 'in_progress', started_at = ?, direction = ? WHERE vapi_call_id = ? AND status NOT IN ('completed','missed','answered','voicemail','blocked')`).run(startedAt, direction, vapiCallId);
        } else {
          const newId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          // For inbound: use resolved name from identity check (handles Gonzalo + contacts)
          let callerName = callerNumber;
          if (isInbound && callerNumber) {
            callerName = inboundIdentity?.name ?? callerNumber;
          }
          const objective = isInbound ? 'Llamada entrante' : '';
          db.prepare(`INSERT INTO calls (id, vapi_call_id, to_number, contact_name, objective, direction, status, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, datetime('now'))`).run(newId, vapiCallId, callerNumber, callerName, objective, direction, startedAt);
          if (isInbound) {
            db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`).run(`Llamada entrante de ${callerName}`);
          }
        }
        // Mark Thorn as on a call
        db.prepare(`UPDATE agents SET status = 'working', current_task = ?, updated_at = unixepoch() WHERE id = 'thorn'`).run(`En llamada${callerNumber ? ` con ${callerNumber}` : ''}`);
        // Push SSE so the dashboard live call banner appears immediately
        const pushFnWh = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
        if (pushFnWh) {
          // Always re-fetch after UPDATE so the SSE row has the latest status/started_at
          const callRowWh = db.prepare(`SELECT * FROM calls WHERE vapi_call_id = ?`).get(vapiCallId) as Record<string, unknown> | undefined;
          if (callRowWh) {
            // Normalize contact_name for the banner (same logic as GET /api/calls)
            const normalizedWh = {
              ...callRowWh,
              contact_name: (callRowWh['contact_name'] as string | null) || (callRowWh['to_number'] as string | null) || 'Unknown',
              started_at: (callRowWh['started_at'] as string | null) || (callRowWh['created_at'] as string | null),
            };
            pushFnWh(`data: ${JSON.stringify({ type: 'call_started', call: normalizedWh })}\n\n`);
          }
          const allCallsWh = (db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all() as Record<string, unknown>[]).map((c) => ({ ...c, contact_name: (c['contact_name'] as string | null) || (c['to_number'] as string | null) || 'Unknown', started_at: (c['started_at'] as string | null) || (c['created_at'] as string | null) }));
          pushFnWh(`data: ${JSON.stringify({ type: 'calls', rows: allCallsWh })}\n\n`);
        }
      } else if (eventType === 'call-ended') {
        const artifact = (message['artifact'] as Record<string, unknown> | undefined) ?? {};
        const rawTranscript = (artifact['transcript'] as string | undefined) ?? '';
        const endedReason = (callObj['endedReason'] as string | undefined) ?? (body['endedReason'] as string | undefined) ?? '';
        const startedAt = (callObj['startedAt'] as string | undefined);
        const endedAt = (callObj['endedAt'] as string | undefined) ?? new Date().toISOString();
        const durationSeconds = (startedAt && endedAt) ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000) : 0;
        const objAchieved = detectObjectiveAchieved(rawTranscript);
        // Extract cost from Vapi payload — Vapi sends call.costs as an array with a 'total' entry
        const vapiCosts = (callObj['costs'] as Array<Record<string, unknown>> | undefined) ?? [];
        let callCostUsd = 0;
        if (Array.isArray(vapiCosts) && vapiCosts.length > 0) {
          const totalEntry = vapiCosts.find(c => c['type'] === 'total');
          if (totalEntry) {
            callCostUsd = Number(totalEntry['cost'] ?? 0);
          } else {
            // Sum all cost entries as fallback
            callCostUsd = vapiCosts.reduce((sum, c) => sum + Number(c['cost'] ?? 0), 0);
          }
        } else if (callObj['cost'] != null) {
          // Vapi sometimes puts cost directly on call object
          callCostUsd = Number(callObj['cost']);
        }
        // Map ended_reason to human-readable summary (stored in summary column)
        const summaryMap: Record<string, string> = { 'customer-ended-call': 'Completada', 'silence-timed-out': 'Sin respuesta (silencio)', 'customer-did-not-answer': 'No contestó', 'voicemail': 'Buzón de voz', 'assistant-ended-call': 'Completada', 'max-duration-exceeded': 'Duración máxima alcanzada' };
        const callSummary = summaryMap[endedReason] ?? endedReason ?? 'Desconocido';
        // Compute proper outcome ('success'/'partial'/'failed') for dashboard badges
        const failedReasons = ['silence-timed-out', 'customer-did-not-answer', 'no-answer', 'busy'];
        const partialReasons = ['voicemail', 'max-duration-exceeded'];
        const outcome = failedReasons.includes(endedReason) ? 'failed'
          : partialReasons.includes(endedReason) ? 'partial'
          : objAchieved ? 'success' : 'partial';
        if (existing) {
          db.prepare(`UPDATE calls SET status = 'completed', transcript = ?, duration_seconds = ?, outcome = ?, summary = ?, objective_achieved = ?, ended_reason = ?, ended_at = ?, cost_usd = ? WHERE vapi_call_id = ?`).run(rawTranscript, durationSeconds, outcome, callSummary, objAchieved, endedReason, endedAt, callCostUsd || null, vapiCallId);
        } else {
          const newId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const customer = (callObj['customer'] as Record<string, unknown> | undefined) ?? {};
          const callerNum = (customer['number'] as string | undefined) ?? '';
          const callType2 = (callObj['type'] as string | undefined) ?? '';
          const isInbound2 = callType2 === 'inboundPhoneCall';
          const direction2 = isInbound2 ? 'inbound' : 'outbound';
          let callerName2 = callerNum;
          if (isInbound2 && callerNum) {
            const cleanNum = callerNum.replace(/\s+/g, '');
            const contact2 = db.prepare(`SELECT name FROM contacts WHERE replace(phone,' ','') = ? OR replace(phone,' ','') LIKE ? LIMIT 1`).get(cleanNum, `%${cleanNum.slice(-10)}`) as { name: string } | undefined;
            callerName2 = contact2?.name ?? callerNum;
          }
          db.prepare(`INSERT INTO calls (id, vapi_call_id, to_number, contact_name, direction, status, transcript, duration_seconds, outcome, summary, objective_achieved, ended_reason, started_at, ended_at, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(newId, vapiCallId, callerNum, callerName2, direction2, rawTranscript, durationSeconds, outcome, callSummary, objAchieved, endedReason, startedAt ?? null, endedAt, callCostUsd || null);
        }
        const callName = (existing?.['contact_name'] as string | undefined) ?? vapiCallId;
        db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, ?, 'executive', datetime('now'))`).run(`Llamada terminada: ${callName} — ${callSummary}`, objAchieved ? 'success' : 'info');
        // Reset Thorn's status back to active now that the call is over
        db.prepare(`UPDATE agents SET status = 'active', current_task = NULL, updated_at = unixepoch() WHERE id = 'thorn' AND status = 'working'`).run();
        // Notify Gonzalo via Telegram when a call ends — AI summary as voice note
        // Atomic claim: only ONE endpoint fires the notification (dedup across /api/vapi, /api/vapi/inbound, etc.)
        void (async () => {
          const notifyClaim = db.prepare(`UPDATE calls SET notification_sent = 1 WHERE vapi_call_id = ? AND (notification_sent IS NULL OR notification_sent = 0)`).run(vapiCallId);
          if (notifyClaim.changes === 0) return; // another endpoint already sent it
          const botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
          const chatId = process.env['ALLOWED_CHAT_ID'] ?? '';
          if (botToken && chatId) {
            const callObjective = (existing?.['objective'] as string | undefined) ?? '';
            await notifyCallEnded({ botToken, chatId, contactName: callName, objective: callObjective, durationSeconds, callSummary, transcript: rawTranscript, logPrefix: 'vapi-webhook' });
          }
        })();
      }
      // Handle live transcript turns
      if (eventType === 'transcript' || eventType === 'speech-update') {
        try {
          const role = (message['role'] as string | undefined) ?? 'unknown';
          const text = (message['transcript'] as string | undefined) ?? (message['text'] as string | undefined) ?? '';
          const transcriptType = (message['transcriptType'] as string | undefined) ?? 'final';
          const isFinal = transcriptType === 'final' ? 1 : 0;
          const callRow = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallId) as { id: string } | undefined;
          if (callRow && text.trim() && eventType === 'transcript') {
            const result = db.prepare(
              `INSERT INTO call_transcripts (call_id, vapi_call_id, role, text, is_final, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
            ).run(callRow.id, vapiCallId, role, text.trim(), isFinal);
            const newRow = { id: result.lastInsertRowid, call_id: callRow.id, vapi_call_id: vapiCallId, role, text: text.trim(), is_final: isFinal, created_at: new Date().toISOString() };
            const pushFn = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
            if (pushFn) { pushFn(`data: ${JSON.stringify({ type: 'call_transcript', rows: [newRow] })}\n\n`); }
          }
        } catch (tErr) { logger.warn({ err: tErr }, '[vapi-webhook] transcript turn failed'); }
        res.json({ ok: true });
        return;
      }

      cacheInvalidate('calls');
      // Push call_ended SSE so the dashboard live banner clears immediately
      if (eventType === 'call-ended') {
        const pushFnEnd = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
        if (pushFnEnd) {
          pushFnEnd(`data: ${JSON.stringify({ type: 'call_ended', vapiCallId })}\n\n`);
          const allCallsEnd = (db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all() as Record<string, unknown>[]).map((c) => ({ ...c, contact_name: (c['contact_name'] as string | null) || (c['to_number'] as string | null) || 'Unknown', started_at: (c['started_at'] as string | null) || (c['created_at'] as string | null) }));
          pushFnEnd(`data: ${JSON.stringify({ type: 'calls', rows: allCallsEnd })}\n\n`);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, '[vapi-webhook] error processing event');
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/vapi/inbound — Vapi assistant-request webhook (dynamic assistant selection)
  // Vapi calls this when the phone number has no fixed assistantId, letting us pick one per call.
  // Also used for status-update events when the server URL is set on the phone number.
  app.post('/api/vapi/inbound', async (req: Request, res: Response) => {
    try {
      // HMAC verification
      if (!verifyVapiSignature(req)) {
        logger.warn('[vapi/inbound] Invalid signature — rejected');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const message = (body['message'] ?? body) as Record<string, unknown>;
      const msgType = (message['type'] as string | undefined) ?? '';

      logger.info({ msgType }, '[vapi/inbound] received');

      // Handle assistant-request: return the correct assistant based on caller identity
      if (msgType === 'assistant-request') {
        const callObj = (message['call'] as Record<string, unknown> | undefined) ?? {};
        const customer = (callObj['customer'] as Record<string, unknown> | undefined) ?? {};
        const callerNumber = (customer['number'] as string | undefined) ?? '';

        // Always check caller identity (returns isGonzalo even if no whitelist configured)
        const identity = checkCallerIdentity(callerNumber);
        const callerDisplay = identity.name ?? callerNumber;

        if (callerNumber) {
          logger.info({ callerNumber, allowed: identity.allowed, isGonzalo: identity.isGonzalo }, '[vapi/inbound] assistant-request caller check');
          db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, ?, 'executive', datetime('now'))`).run(
            `Solicitud de asistente — ${identity.isGonzalo ? 'Gonzalo (verificado)' : identity.known ? 'conocido' : 'desconocido'}: ${callerDisplay}`,
            identity.allowed ? 'info' : 'warning'
          );
          void alertInboundCall(callerDisplay, identity.allowed);
          if (!identity.allowed) {
            // Block caller — Vapi will hang up
            return res.json({
              error: { type: 'no-assistant-available', message: 'Lo siento, no puedo atenderte en este momento.' }
            });
          }
        }

        const thornAssistantId = process.env['VAPI_ASSISTANT_ID'] ?? 'b12b30d9-a75b-48de-a19b-b494e1eaa1a3';
        const voiceId = process.env['ELEVENLABS_VOICE_ID'] ?? '';
        const dateStr = new Date().toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Monterrey' });

        if (identity.isGonzalo) {
          // ── Owner verified: full Thorn access, identical to Telegram ──
          logger.info('[vapi/inbound] Owner verified — granting full Thorn access');

          // Load owner's memory context fresh on every call (same as Telegram bot does)
          // Salience-first ordering surfaces the most important memories, then recency.
          const ownerChatId = process.env['ALLOWED_CHAT_ID'] ?? '';
          let memoryLines: string[] = [];
          try {
            const recentMems = db.prepare(
              `SELECT content, sector FROM memories
               WHERE chat_id = ?
               ORDER BY salience DESC, accessed_at DESC
               LIMIT 15`
            ).all(ownerChatId) as Array<{ content: string; sector: string }>;
            memoryLines = recentMems.map(m => `- ${m.content} (${m.sector})`);
          } catch (_memErr) { /* non-fatal */ }
          const ownerNameVapi = process.env['OWNER_NAME'] || 'the owner';
          const memoryBlock = memoryLines.length > 0
            ? `\n\n[Memory context — things ${ownerNameVapi} has shared before]\n${memoryLines.join('\n')}\n[End memory context]`
            : '';

          const dashboardUrl = process.env['DASHBOARD_URL'] || 'https://keisha-inescapable-clavately.ngrok-free.dev';
          // Read CLAUDE.md fresh on every call so personality/rules are always current
          const claudeMdPath = path.join(__dirname, '..', 'CLAUDE.md');
          let claudeMdContent = '';
          try { claudeMdContent = fs.readFileSync(claudeMdPath, 'utf-8'); } catch (_) { /* fallback below */ }

          // Current time injected fresh per call (same pattern as Telegram bot)
          const callNow = new Date();
          const timeStr = callNow.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/Monterrey' });

          // Voice-adapted full system prompt: CLAUDE.md + memory + call-specific context
          const callToolBlock = `\n\n## TOOL USE — NON-NEGOTIABLE\n\nYou have tools. You MUST call them. Saying you will do something without calling a tool means it NEVER happens.\n\nTOOLS:\n- check_calendar: look up today/tomorrow events\n- create_event: schedule something\n- create_task: create a task ticket\n- save_note: save a note\n- web_search: search the internet\n- send_telegram: send Gonzalo a Telegram message\n- read_emails: check Gmail\n- lookup_contact: search contacts\n- make_call: place an outbound call\n- delegate_to_thorn: send ANY task to the agent team for execution\n\nRULE 1 — NEVER VERBALLY PROMISE WITHOUT CALLING A TOOL.\nIf you say "lo registro", "queda registrado", "se lo paso al equipo", "lo delego", "me encargo", "listo" — you MUST have ALREADY called delegate_to_thorn in that same turn. If you did not call the tool, those words are a lie. Do not say them.\n\nRULE 2 — delegate_to_thorn is the ONLY way tasks get executed.\nCalling delegate_to_thorn is not optional when Gonzalo asks for action. It is the action. Not calling it means nothing happens.\n\nRULE 3 — When in doubt, call delegate_to_thorn.\nAny request involving: code changes, UI fixes, content, research, emails, scheduling, analysis, writing — call delegate_to_thorn FIRST, speak SECOND.\n\nRULE 4 — Call the tool before speaking the confirmation.\nThe tool call must happen IN THE SAME TURN as the confirmation. You cannot say "listo" then call the tool in the next turn.\n\nCORRECT EXAMPLES:\n- Gonzalo: "cambia el texto en settings de v5 a v6" -> [call delegate_to_thorn("Cambiar label de version en Settings > Profile de OpoClaw v5.0 a OpoClaw v6.0. Cambio puramente visual en frontend.")] -> say: "Listo, en eso queda el equipo de frontend. Te avisan por Telegram cuando quede."\n- Gonzalo: "busca noticias de OpenAI" -> [call delegate_to_thorn("Busca noticias recientes sobre OpenAI y enviale un resumen a Gonzalo por Telegram.")] -> say: "Rafaelo en eso. Te llega el resumen por Telegram."\n- Gonzalo: "agenda una junta" -> [call create_event(...)] -> confirm verbally.\n\nWRONG (NEVER DO THIS):\n- Gonzalo: "cambia el texto" -> say: "Listo, queda registrado." [NO TOOL CALLED = NOTHING HAPPENED]\n- Gonzalo: "pasa esto al equipo" -> say: "Se lo paso al equipo de front." [NO TOOL CALLED = EMPTY PROMISE]\n\nAfter calling delegate_to_thorn successfully, say exactly: "Listo, en eso queda el equipo. Te mandan el resultado por Telegram."`;

          const ownerNameCall = process.env['OWNER_NAME'] || 'the owner';
          const voiceSystemPrompt = claudeMdContent
            ? `${claudeMdContent}\n\n---\n\n## PHONE CALL CONTEXT\n\nYou are now on a PHONE CALL with ${ownerNameCall}. Everything above applies — same personality, same rules, same access. Same Thorn as in Telegram.\n\nAdapt for voice:\n- Keep responses short and spoken-friendly. No bullet points, no markdown, no lists unless asked.\n- One clear answer per turn.\n- Today is ${dateStr}, current time is ${timeStr}. ${ownerNameCall} is calling from their verified number.${callToolBlock}${memoryBlock}`
            : `You are Thorn, the personal assistant and COO of OpoClaw. You are on a phone call. Today is ${dateStr}, current time is ${timeStr}. ${ownerNameCall} is calling from their verified number.\n\nPersonality rules:\n- No emojis. Ever.\n- No em dashes.\n- No AI cliches.\n- Talk like a real person — direct, no filler.\n- Keep voice responses short and spoken-friendly.\n- One clear answer per turn.${callToolBlock}${memoryBlock}`;

          // Build the tools list for the owner's assistant — all tools implemented in /api/vapi
          const gonzaloTools = [
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 20 },
              function: {
                name: 'check_calendar',
                description: "Returns Gonzalo's calendar events for today and tomorrow",
                parameters: { type: 'object', properties: {} },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 20 },
              function: {
                name: 'create_event',
                description: 'Creates a calendar event in Google Calendar and locally',
                parameters: {
                  type: 'object',
                  required: ['title', 'date'],
                  properties: {
                    title: { type: 'string', description: 'Event title' },
                    date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
                    time: { type: 'string', description: 'Time in HH:MM format (24h), optional' },
                    duration: { type: 'string', description: 'Duration in minutes, defaults to 60' },
                    description: { type: 'string', description: 'Optional description or notes' },
                  },
                },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 20 },
              function: {
                name: 'create_task',
                description: 'Creates a task on the OpoClaw task board',
                parameters: {
                  type: 'object',
                  required: ['title'],
                  properties: {
                    title: { type: 'string', description: 'Short task title' },
                    description: { type: 'string', description: 'Additional details' },
                    assignee: { type: 'string', description: 'Agent ID to assign to, e.g. marcus-reyes' },
                  },
                },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 20 },
              function: {
                name: 'save_note',
                description: 'Saves a note to BrainVault for later retrieval',
                parameters: {
                  type: 'object',
                  required: ['content'],
                  properties: {
                    title: { type: 'string', description: 'Title for the note' },
                    content: { type: 'string', description: 'The note content to save' },
                  },
                },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 30 },
              function: {
                name: 'web_search',
                description: 'Searches the web and returns a short answer. Use for news, facts, current info.',
                parameters: {
                  type: 'object',
                  required: ['query'],
                  properties: {
                    query: { type: 'string', description: 'The search query' },
                  },
                },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 20 },
              function: {
                name: 'send_telegram',
                description: 'Sends a text message to Gonzalo via Telegram',
                parameters: {
                  type: 'object',
                  required: ['message'],
                  properties: {
                    message: { type: 'string', description: 'The message to send' },
                  },
                },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 30 },
              function: {
                name: 'read_emails',
                description: "Reads Gonzalo's latest unread emails from Gmail",
                parameters: { type: 'object', properties: {} },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 20 },
              function: {
                name: 'lookup_contact',
                description: "Looks up a person in Gonzalo's contacts",
                parameters: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', description: 'Name or partial name to search for' },
                  },
                },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 30 },
              function: {
                name: 'make_call',
                description: 'Makes an outbound phone call via Vapi on behalf of Gonzalo',
                parameters: {
                  type: 'object',
                  required: ['phone_number', 'task'],
                  properties: {
                    phone_number: { type: 'string', description: 'Phone number to call in E.164 format' },
                    task: { type: 'string', description: 'Instructions for what to say and accomplish on the call' },
                    create_event_on_success: { type: 'string', description: 'Set to "true" to auto-create a calendar event if successful' },
                    event_title: { type: 'string', description: 'Title for the calendar event if creating one' },
                    event_date: { type: 'string', description: 'Date for the event in YYYY-MM-DD' },
                    event_time: { type: 'string', description: 'Time for the event in HH:MM' },
                  },
                },
              },
            },
            {
              type: 'function',
              server: { url: `${dashboardUrl}/api/vapi`, timeoutSeconds: 10 },
              function: {
                name: 'delegate_to_thorn',
                description: 'Sends a task directly into the Thorn Telegram pipeline for full agent execution. Use for anything complex: research, writing, code, multi-step tasks, sending emails, or anything needing more than 30 seconds. Thorn will execute and send results to Gonzalo via Telegram.',
                parameters: {
                  type: 'object',
                  required: ['instruction'],
                  properties: {
                    instruction: { type: 'string', description: 'The full task instruction for Thorn to execute — be specific and complete, as if you were sending a Telegram message to Thorn yourself' },
                  },
                },
              },
            },
          ];

          logger.info({ memoryCount: memoryLines.length, claudeMdLen: claudeMdContent.length, toolCount: gonzaloTools.length }, '[vapi/inbound] Gonzalo system prompt built fresh — memory + CLAUDE.md + tools loaded');

          return res.json({
            assistantId: thornAssistantId,
            assistantOverrides: {
              firstMessage: 'Hola Gonzalo, dime.',
              model: {
                provider: 'anthropic',
                model: 'claude-opus-4-6',
                messages: [{
                  role: 'system',
                  content: voiceSystemPrompt,
                }],
                tools: gonzaloTools,
                maxTokens: 512,
              },
              serverUrl: `${dashboardUrl}/api/vapi/inbound`,
              server: { url: `${dashboardUrl}/api/vapi/inbound`, timeoutSeconds: 20 },
            },
          });
        }

        // ── Unknown caller: intelligent assistant — takes messages, creates tasks, notifies owner ──
        logger.info({ callerNumber, callerDisplay }, '[vapi/inbound] Unknown caller — smart message-taking mode');
        const ownerNameInbound = process.env['OWNER_NAME'] || 'the owner';
        const dashboardUrlStranger = process.env['DASHBOARD_URL'] || '';
        return res.json({
          assistant: {
            firstMessage: `Hola, soy el asistente de ${ownerNameInbound}. En que le puedo ayudar?`,
            model: {
              provider: 'anthropic',
              model: 'claude-haiku-4-5',
              messages: [{
                role: 'system',
                content: `Eres el asistente de ${ownerNameInbound}. Hoy es ${dateStr}. NO eres Thorn. Tu funcion: ayudar al visitante y siempre notificar al propietario.\n\nReglas:\n- Habla en espanol natural, sin emojis, sin frases de AI.\n- Jamas des informacion personal, de agenda, financiera o de negocio del propietario.\n- Si alguien pide hablar con ${ownerNameInbound} directamente, di que no esta disponible en este momento.\n\nFlujos que debes manejar:\n1. Si quiere dejar un mensaje: pregunta su nombre y el mensaje. Luego llama send_message_to_gonzalo. Luego llama create_task con un titulo como "Mensaje de [nombre]: [resumen]". Confirma al visitante que el mensaje fue enviado.\n2. Si pide que ${ownerNameInbound} le devuelva la llamada: pregunta su nombre y numero. Llama send_message_to_gonzalo con el numero incluido. Confirma que notificaste al propietario.\n3. Cualquier otro asunto: toma el nombre y asunto, llama send_message_to_gonzalo, confirma.\n\nSiempre al final: confirma al visitante que sera notificado.`,
              }],
              tools: [
                {
                  type: 'function',
                  server: { url: `${dashboardUrlStranger}/api/vapi` },
                  function: {
                    name: 'send_message_to_gonzalo',
                    description: 'Envia un mensaje de texto a Gonzalo por Telegram notificandole de la llamada',
                    parameters: {
                      type: 'object',
                      required: ['caller_name', 'message'],
                      properties: {
                        caller_name: { type: 'string', description: 'Nombre de quien llama' },
                        message: { type: 'string', description: 'El mensaje o asunto para Gonzalo' },
                        caller_phone: { type: 'string', description: 'Numero de telefono del visitante si lo proporcionó' },
                      },
                    },
                  },
                },
                {
                  type: 'function',
                  server: { url: `${dashboardUrlStranger}/api/vapi` },
                  function: {
                    name: 'create_task',
                    description: 'Crea una tarea de seguimiento en el dashboard de OpoClaw',
                    parameters: {
                      type: 'object',
                      required: ['title'],
                      properties: {
                        title: { type: 'string', description: 'Titulo breve de la tarea' },
                        description: { type: 'string', description: 'Detalles adicionales' },
                      },
                    },
                  },
                },
              ],
              maxTokens: 300,
            },
            voice: voiceId ? { provider: '11labs', voiceId, stability: 0.5, similarityBoost: 0.75, model: 'eleven_turbo_v2_5' } : undefined,
            transcriber: { provider: 'deepgram', model: 'nova-2', language: 'es', endpointing: 100 },
            serverUrl: `${dashboardUrlStranger}/api/vapi/inbound`,
          },
        });
      }

      // Handle call-started events
      if (msgType === 'call-started') {
        const callObjCs = (message['call'] as Record<string, unknown> | undefined) ?? {};
        const vapiCallIdCs = (callObjCs['id'] as string | undefined) ?? '';
        logger.info({ vapiCallId: vapiCallIdCs }, '[vapi/inbound] call-started');
        if (vapiCallIdCs) {
          const callTypeCs = (callObjCs['type'] as string | undefined) ?? '';
          const isInboundCs = callTypeCs === 'inboundPhoneCall';
          const customerCs = (callObjCs['customer'] as Record<string, unknown> | undefined) ?? {};
          const callerNumberCs = (customerCs['number'] as string | undefined) ?? '';
          const startedAtCs = (callObjCs['startedAt'] as string | undefined) ?? new Date().toISOString();
          const existingCallCs = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdCs);
          if (!existingCallCs) {
            const idCs = isInboundCs && callerNumberCs ? checkCallerIdentity(callerNumberCs) : null;
            const callerNameCs = idCs?.name ?? callerNumberCs;
            const directionCs = isInboundCs ? 'inbound' : 'outbound';
            const newIdCs = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            db.prepare(`INSERT OR IGNORE INTO calls (id, vapi_call_id, to_number, contact_name, objective, direction, status, caller_allowed, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, datetime('now'))`).run(newIdCs, vapiCallIdCs, callerNumberCs, callerNameCs, isInboundCs ? 'Llamada entrante' : '', directionCs, idCs?.allowed ? 1 : 0, startedAtCs);
            db.prepare(`UPDATE agents SET status = 'working', current_task = ?, updated_at = unixepoch() WHERE id = 'thorn'`).run(`En llamada${callerNumberCs ? ` con ${callerNameCs || callerNumberCs}` : ''}`);
            cacheInvalidate('calls');
            const pushFnCs = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
            if (pushFnCs) {
              const newCallRowCs = db.prepare(`SELECT * FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdCs);
              // Push both call_started (for direct consumers) and calls (for React Query invalidation)
              pushFnCs(`data: ${JSON.stringify({ type: 'call_started', call: newCallRowCs })}\n\n`);
              const allCallsCs = (db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all() as Record<string, unknown>[]).map((c) => ({ ...c, contact_name: (c['contact_name'] as string | null) || (c['to_number'] as string | null) || 'Unknown', started_at: (c['started_at'] as string | null) || (c['created_at'] as string | null) }));
              pushFnCs(`data: ${JSON.stringify({ type: 'calls', rows: allCallsCs })}\n\n`);
            }
          } else {
            // Guard: only update to in_progress if not already completed/ended
            db.prepare(`UPDATE calls SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE vapi_call_id = ? AND status NOT IN ('completed','missed','answered','voicemail','blocked')`).run(startedAtCs, vapiCallIdCs);
            cacheInvalidate('calls');
            // Also push calls update so dashboard reacts immediately
            const pushFnCsUpd = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
            if (pushFnCsUpd) {
              const allCallsCsUpd = (db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all() as Record<string, unknown>[]).map((c) => ({ ...c, contact_name: (c['contact_name'] as string | null) || (c['to_number'] as string | null) || 'Unknown', started_at: (c['started_at'] as string | null) || (c['created_at'] as string | null) }));
              pushFnCsUpd(`data: ${JSON.stringify({ type: 'calls', rows: allCallsCsUpd })}\n\n`);
            }
          }
        }
        return res.json({ ok: true });
      }

      // Handle call-ended events
      if (msgType === 'call-ended') {
        const callObjCe = (message['call'] as Record<string, unknown> | undefined) ?? {};
        const vapiCallIdCe = (callObjCe['id'] as string | undefined) ?? '';
        const endedReasonCe = (callObjCe['endedReason'] as string | undefined) ?? (message['endedReason'] as string | undefined) ?? '';
        const startedAtCe = (callObjCe['startedAt'] as string | undefined);
        const endedAtCe = (callObjCe['endedAt'] as string | undefined) ?? new Date().toISOString();
        const artifactCe = (message['artifact'] as Record<string, unknown> | undefined) ?? {};
        const rawTranscriptCe = (artifactCe['transcript'] as string | undefined) ?? '';
        const durationSecondsCe = (startedAtCe && endedAtCe) ? Math.round((new Date(endedAtCe).getTime() - new Date(startedAtCe).getTime()) / 1000) : 0;
        const ceSummaryMap: Record<string, string> = { 'customer-ended-call': 'Completada', 'silence-timed-out': 'Sin respuesta', 'customer-did-not-answer': 'No contesto', 'voicemail': 'Buzon de voz', 'assistant-ended-call': 'Completada', 'max-duration-exceeded': 'Duracion maxima' };
        const ceSummary = ceSummaryMap[endedReasonCe] ?? endedReasonCe ?? 'Desconocido';
        // Compute proper outcome enum (success/partial/failed) — not human text
        const ceFailedReasons = ['silence-timed-out', 'customer-did-not-answer', 'no-answer', 'busy'];
        const cePartialReasons = ['voicemail', 'max-duration-exceeded'];
        const ceObjAchieved = (!ceFailedReasons.includes(endedReasonCe) && !cePartialReasons.includes(endedReasonCe)) ? 1 : 0;
        const ceOutcome = ceFailedReasons.includes(endedReasonCe) ? 'failed' : cePartialReasons.includes(endedReasonCe) ? 'partial' : ceObjAchieved ? 'success' : 'partial';
        logger.info({ vapiCallId: vapiCallIdCe, endedReason: endedReasonCe, durationSeconds: durationSecondsCe }, '[vapi/inbound] call-ended');
        if (vapiCallIdCe) {
          const endedCallRow = db.prepare(`SELECT id, contact_name FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdCe) as { id: string; contact_name: string } | undefined;
          if (endedCallRow) {
            db.prepare(`UPDATE calls SET status = 'completed', transcript = ?, duration_seconds = ?, outcome = ?, summary = ?, objective_achieved = ?, ended_reason = ?, ended_at = ? WHERE vapi_call_id = ?`).run(rawTranscriptCe, durationSecondsCe, ceOutcome, ceSummary, ceObjAchieved, endedReasonCe, endedAtCe, vapiCallIdCe);
          }
          db.prepare(`UPDATE agents SET status = 'active', current_task = NULL, updated_at = unixepoch() WHERE id = 'thorn' AND status = 'working'`).run();
          db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`).run(`Llamada terminada: ${endedCallRow?.contact_name ?? vapiCallIdCe} — ${ceSummary}`);
          cacheInvalidate('calls');
          const pushFnCe = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
          if (pushFnCe) {
            pushFnCe(`data: ${JSON.stringify({ type: 'call_ended', vapiCallId: vapiCallIdCe, outcome: ceOutcome })}\n\n`);
            // Also push full calls list so React Query caches are immediately invalidated
            const allCallsCe = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
            pushFnCe(`data: ${JSON.stringify({ type: 'calls', rows: allCallsCe })}\n\n`);
          }
          // Notify Gonzalo via Telegram — atomic claim prevents duplicate notifications from other endpoints
          void (async () => {
            const notifyClaimCe = db.prepare(`UPDATE calls SET notification_sent = 1 WHERE vapi_call_id = ? AND (notification_sent IS NULL OR notification_sent = 0)`).run(vapiCallIdCe);
            if (notifyClaimCe.changes === 0) return;
            const botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
            const chatId = process.env['ALLOWED_CHAT_ID'] ?? '';
            if (botToken && chatId) {
              const contactNameCe = endedCallRow?.contact_name ?? vapiCallIdCe;
              const ceObjective = (endedCallRow as Record<string, unknown> | undefined)?.['objective'] as string ?? '';
              await notifyCallEnded({ botToken, chatId, contactName: contactNameCe, objective: ceObjective, durationSeconds: durationSecondsCe, callSummary: ceSummary, transcript: rawTranscriptCe, logPrefix: 'vapi/inbound' });
            }
          })();
        }
        return res.json({ ok: true });
      }

      // Handle status-update events (fallback for when call-started isn't fired)
      if (msgType === 'status-update') {
        const callObj = (message['call'] as Record<string, unknown> | undefined) ?? {};
        const vapiCallId = (callObj['id'] as string | undefined) ?? '';
        const status = (message['status'] as string | undefined) ?? '';
        logger.info({ vapiCallId, status }, '[vapi/inbound] status-update');
        if (vapiCallId && status === 'in-progress') {
          const callType = (callObj['type'] as string | undefined) ?? '';
          const isInbound = callType === 'inboundPhoneCall';
          if (isInbound) {
            const customer = (callObj['customer'] as Record<string, unknown> | undefined) ?? {};
            const callerNumber = (customer['number'] as string | undefined) ?? '';
            const existing = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallId);
            if (!existing) {
              const identity = checkCallerIdentity(callerNumber);
              const callerName = identity.name ?? callerNumber;
              const newId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              db.prepare(`INSERT OR IGNORE INTO calls (id, vapi_call_id, to_number, contact_name, objective, direction, status, caller_allowed, started_at, created_at) VALUES (?, ?, ?, ?, 'Llamada entrante', 'inbound', 'in_progress', ?, ?, datetime('now'))`).run(newId, vapiCallId, callerNumber, callerName, identity.allowed ? 1 : 0, new Date().toISOString());
              cacheInvalidate('calls');
              const pushFnSU = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
              if (pushFnSU) {
                const callRowSU = db.prepare(`SELECT * FROM calls WHERE vapi_call_id = ?`).get(vapiCallId);
                pushFnSU(`data: ${JSON.stringify({ type: 'call_started', call: callRowSU })}\n\n`);
              }
            } else {
              db.prepare(`UPDATE calls SET status = 'in_progress' WHERE vapi_call_id = ? AND status IN ('queued')`).run(vapiCallId);
              cacheInvalidate('calls');
            }
          }
        }
        return res.json({ ok: true });
      }

      // Handle transcript events (live turn-by-turn during a call)
      // Vapi fires 'transcript' for each utterance (partial + final) and 'speech-update' for speaking state
      if (msgType === 'transcript' || msgType === 'speech-update') {
        try {
          const callObj = (message['call'] as Record<string, unknown> | undefined) ?? {};
          const vapiCallId = (callObj['id'] as string | undefined) ?? '';
          if (!vapiCallId) { return res.json({ ok: true }); }

          // Resolve our internal call id
          const callRow = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallId) as { id: string } | undefined;
          if (!callRow) { return res.json({ ok: true }); }

          // For transcript events: role = 'user' | 'assistant', text, transcriptType = 'partial' | 'final'
          const role = (message['role'] as string | undefined) ?? 'unknown';
          const text = (message['transcript'] as string | undefined) ?? (message['text'] as string | undefined) ?? '';
          const transcriptType = (message['transcriptType'] as string | undefined) ?? 'final';
          const isFinal = transcriptType === 'final' ? 1 : 0;

          // Only save user turns from transcript events — assistant turns come from conversation-update
          if (msgType === 'transcript' && text.trim() && role === 'user') {
            const result = db.prepare(
              `INSERT INTO call_transcripts (call_id, vapi_call_id, role, text, is_final, created_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))`
            ).run(callRow.id, vapiCallId, role, text.trim(), isFinal);

            // Push immediately via SSE so the dashboard updates in real time
            const newRow = {
              id: result.lastInsertRowid,
              call_id: callRow.id,
              vapi_call_id: vapiCallId,
              role,
              text: text.trim(),
              is_final: isFinal,
              created_at: new Date().toISOString(),
            };
            const pushFn = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
            if (pushFn) {
              pushFn(`data: ${JSON.stringify({ type: 'call_transcript', rows: [newRow] })}\n\n`);
            }
            logger.info({ vapiCallId, role, isFinal, len: text.length }, '[vapi/inbound] transcript turn saved');
          }
        } catch (transcriptErr) {
          logger.warn({ err: transcriptErr }, '[vapi/inbound] failed to save transcript turn');
        }
        return res.json({ ok: true });
      }

      // Handle end-of-call-report (Vapi's actual end event — fires when serverUrl is set on assistant)
      if (msgType === 'end-of-call-report') {
        const callObjEoc = (message['call'] as Record<string, unknown> | undefined) ?? {};
        const vapiCallIdEoc = (callObjEoc['id'] as string | undefined) ?? '';
        const endedReasonEoc = (callObjEoc['endedReason'] as string | undefined) ?? (message['endedReason'] as string | undefined) ?? '';
        const startedAtEoc = (callObjEoc['startedAt'] as string | undefined);
        const endedAtEoc = (callObjEoc['endedAt'] as string | undefined) ?? new Date().toISOString();
        const artifactEoc = (message['artifact'] as Record<string, unknown> | undefined) ?? {};
        let rawTranscriptEoc = (artifactEoc['transcript'] as string | undefined) ?? '';
        if (!rawTranscriptEoc && artifactEoc['messages']) {
          const msgs = artifactEoc['messages'] as Array<{ role: string; message?: string; content?: string }>;
          rawTranscriptEoc = JSON.stringify(msgs.map(m => ({ speaker: m.role === 'assistant' ? 'ai' : 'contact', text: m.message ?? m.content ?? '' })));
        }
        const durationMsEoc = (message['durationMs'] as number | undefined) ?? 0;
        const durationSecondsEoc = durationMsEoc ? Math.round(durationMsEoc / 1000)
          : (startedAtEoc && endedAtEoc) ? Math.round((new Date(endedAtEoc).getTime() - new Date(startedAtEoc).getTime()) / 1000) : 0;
        const eocSummaryMap: Record<string, string> = { 'customer-ended-call': 'Completada', 'assistant-ended-call': 'Completada', 'silence-timed-out': 'Sin respuesta', 'customer-did-not-answer': 'No contesto', 'no-answer': 'No contesto', 'voicemail': 'Buzon de voz', 'max-duration-exceeded': 'Duracion maxima', 'busy': 'Linea ocupada' };
        const eocSummary = eocSummaryMap[endedReasonEoc] ?? endedReasonEoc ?? 'Desconocido';
        const eocFailedReasons = ['silence-timed-out', 'customer-did-not-answer', 'no-answer', 'busy'];
        const eocPartialReasons = ['voicemail', 'max-duration-exceeded'];
        const eocObjAchieved = (!eocFailedReasons.includes(endedReasonEoc) && !eocPartialReasons.includes(endedReasonEoc)) ? 1 : 0;
        const eocOutcome = eocFailedReasons.includes(endedReasonEoc) ? 'failed' : eocPartialReasons.includes(endedReasonEoc) ? 'partial' : eocObjAchieved ? 'success' : 'partial';
        logger.info({ vapiCallId: vapiCallIdEoc, endedReason: endedReasonEoc, durationSeconds: durationSecondsEoc }, '[vapi/inbound] end-of-call-report');
        if (vapiCallIdEoc) {
          const eocCallRow = db.prepare(`SELECT id, contact_name, objective FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdEoc) as { id: string; contact_name: string; objective: string } | undefined;
          if (eocCallRow) {
            db.prepare(`UPDATE calls SET status = 'completed', transcript = ?, duration_seconds = ?, outcome = ?, summary = ?, objective_achieved = ?, ended_reason = ?, ended_at = ? WHERE vapi_call_id = ?`).run(rawTranscriptEoc, durationSecondsEoc, eocOutcome, eocSummary, eocObjAchieved, endedReasonEoc, endedAtEoc, vapiCallIdEoc);
          } else if (vapiCallIdEoc) {
            // Create a record if it was never created (e.g. call-started was missed)
            const newEocId = `call-${Date.now()}-eoc`;
            db.prepare(`INSERT OR IGNORE INTO calls (id, vapi_call_id, to_number, contact_name, objective, direction, status, transcript, duration_seconds, outcome, summary, objective_achieved, ended_reason, ended_at, created_at) VALUES (?, ?, 'unknown', 'Inbound Call', 'Llamada entrante', 'inbound', 'completed', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(newEocId, vapiCallIdEoc, rawTranscriptEoc, durationSecondsEoc, eocOutcome, eocSummary, eocObjAchieved, endedReasonEoc, endedAtEoc);
          }

          // Backfill call_transcripts from artifact.messages if live capture missed them.
          // We always have the full conversation in artifact.messages at end-of-call.
          // Case 1: no turns at all → full backfill (both user and assistant).
          // Case 2: user turns exist but NO assistant turns → backfill only assistant turns
          //         (happens when conversation-update didn't fire or had role normalisation bugs).
          const finalCallRow = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdEoc) as { id: string } | undefined;
          if (finalCallRow && artifactEoc['messages']) {
            const existingTurns = (db.prepare(`SELECT COUNT(*) as n FROM call_transcripts WHERE vapi_call_id = ?`).get(vapiCallIdEoc) as { n: number })?.n ?? 0;
            const existingAssistantTurns = (db.prepare(`SELECT COUNT(*) as n FROM call_transcripts WHERE vapi_call_id = ? AND role = 'assistant'`).get(vapiCallIdEoc) as { n: number })?.n ?? 0;
            const needsFullBackfill = existingTurns === 0;
            const needsAssistantBackfill = existingTurns > 0 && existingAssistantTurns === 0;
            if (needsFullBackfill || needsAssistantBackfill) {
              const artifactMsgs = artifactEoc['messages'] as Array<Record<string, unknown>>;
              const pushFnEocBf = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
              let backfilled = 0;
              for (const m of artifactMsgs) {
                const rawRole = (m['role'] as string | undefined) ?? 'user';
                const role: 'assistant' | 'user' = (rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'ai') ? 'assistant' : 'user';
                // In partial-backfill mode, skip user turns (they already exist)
                if (needsAssistantBackfill && role !== 'assistant') continue;
                const text = ((m['message'] as string | undefined) ?? (m['content'] as string | undefined) ?? '').trim();
                if (!text) continue;
                const result = db.prepare(
                  `INSERT INTO call_transcripts (call_id, vapi_call_id, role, text, is_final, created_at) VALUES (?, ?, ?, ?, 1, datetime('now'))`
                ).run(finalCallRow.id, vapiCallIdEoc, role, text);
                if (pushFnEocBf) {
                  const newRow = { id: result.lastInsertRowid, call_id: finalCallRow.id, vapi_call_id: vapiCallIdEoc, role, text, is_final: 1, created_at: new Date().toISOString() };
                  pushFnEocBf(`data: ${JSON.stringify({ type: 'call_transcript', rows: [newRow] })}\n\n`);
                }
                backfilled++;
              }
              if (backfilled > 0) {
                logger.info({ vapiCallId: vapiCallIdEoc, backfilled, mode: needsFullBackfill ? 'full' : 'assistant-only' }, '[vapi/inbound] end-of-call-report: backfilled call_transcripts from artifact.messages');
              }
            }
          }

          db.prepare(`UPDATE agents SET status = 'active', current_task = NULL, updated_at = unixepoch() WHERE id = 'thorn' AND status = 'working'`).run();
          db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`).run(`Llamada terminada: ${eocCallRow?.contact_name ?? vapiCallIdEoc} — ${eocSummary}`);
          cacheInvalidate('calls');
          const pushFnEoc2 = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
          if (pushFnEoc2) {
            pushFnEoc2(`data: ${JSON.stringify({ type: 'call_ended', vapiCallId: vapiCallIdEoc, outcome: eocOutcome })}\n\n`);
            const allCallsEoc2 = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
            pushFnEoc2(`data: ${JSON.stringify({ type: 'calls', rows: allCallsEoc2 })}\n\n`);
          }
          void (async () => {
            const notifyClaimEoc = db.prepare(`UPDATE calls SET notification_sent = 1 WHERE vapi_call_id = ? AND (notification_sent IS NULL OR notification_sent = 0)`).run(vapiCallIdEoc);
            if (notifyClaimEoc.changes === 0) return;
            const botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
            const chatId = process.env['ALLOWED_CHAT_ID'] ?? '';
            if (botToken && chatId) {
              const contactNameEoc = eocCallRow?.contact_name ?? vapiCallIdEoc;
              const eocObjective = eocCallRow?.objective ?? '';
              await notifyCallEnded({ botToken, chatId, contactName: contactNameEoc, objective: eocObjective, durationSeconds: durationSecondsEoc, callSummary: eocSummary, transcript: rawTranscriptEoc, logPrefix: 'vapi/inbound' });
            }
          })();

          // Post-call processor: extract any action items from the transcript and run
          // them through the real Thorn pipeline even if Vapi AI failed to delegate
          void (async () => {
            try {
              const callIdForTranscript = eocCallRow?.id ?? '';
              if (!callIdForTranscript) return;
              const transcriptsEoc = db.prepare(
                `SELECT role, text FROM call_transcripts WHERE call_id = ? ORDER BY id ASC`
              ).all(callIdForTranscript) as Array<{ role: string; text: string }>;

              if (transcriptsEoc.length === 0) return;

              const conversationEoc = transcriptsEoc
                .map((t) => `${t.role === 'user' ? 'Gonzalo' : 'Thorn'}: ${t.text}`)
                .join('\n');

              const postCallPrompt = `[Resumen de llamada telefónica - procesamiento de tareas pendientes]

Esta es la transcripción de una llamada que acaba de terminar entre Gonzalo y Thorn (el asistente de voz):

${conversationEoc}

Tu tarea: Identifica CUALQUIER acción que Gonzalo haya solicitado durante esta llamada que no haya sido completada. Si hay tareas pendientes, ejecútalas ahora exactamente igual que si Gonzalo te las hubiera enviado por Telegram. Si todo ya fue atendido durante la llamada o no hay acciones pendientes, no envíes ningún mensaje.`;

              const postCallRes = await fetch('http://localhost:3001/api/agents/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent_id: 'thorn', task: postCallPrompt }),
              });
              if (postCallRes.ok) {
                logger.info({ callId: callIdForTranscript }, '[vapi/inbound] post-call processor queued');
              } else {
                logger.warn({ status: postCallRes.status }, '[vapi/inbound] post-call processor failed to queue');
              }
            } catch (postCallErr) {
              logger.error({ err: postCallErr }, '[vapi/inbound] post-call processor error');
            }
          })();
        }
        return res.json({ ok: true });
      }

      // Handle tool-calls: Vapi sends them to assistantOverrides.serverUrl (this endpoint)
      // rather than the per-tool server.url when an assistant-level serverUrl is set.
      // Forward to /api/vapi which has the full tool execution logic.
      if (msgType === 'tool-calls') {
        logger.info('[vapi/inbound] tool-calls received — forwarding to /api/vapi handler');
        try {
          const toolFwdRes = await fetch('http://localhost:3001/api/vapi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
          });
          const toolFwdBody = await toolFwdRes.json() as Record<string, unknown>;
          return res.json(toolFwdBody);
        } catch (toolFwdErr) {
          logger.error({ err: toolFwdErr }, '[vapi/inbound] tool-calls forward failed');
          return res.status(500).json({ error: String(toolFwdErr) });
        }
      }

      // Handle conversation-update — Vapi sends this instead of 'transcript' events.
      // Each conversation-update contains message.messages[], the full conversation so far.
      // We diff against what we already have to insert only new turns in real time.
      if (msgType === 'conversation-update') {
        try {
          const callObj = (message['call'] as Record<string, unknown> | undefined) ?? {};
          const vapiCallId = (callObj['id'] as string | undefined) ?? '';
          if (!vapiCallId) { return res.json({ ok: true }); }

          const callRow = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallId) as { id: string } | undefined;
          if (!callRow) { return res.json({ ok: true }); }

          // Vapi conversation-update: message.messages = [{role, message, time, secondsFromStart}]
          // conversation-update is cumulative — contains the FULL conversation so far.
          // We save ALL turns (user + assistant) from here, since Vapi does not always fire
          // 'transcript' events for user speech (depends on assistant/phone configuration).
          // Deduplicate by total count of already-saved turns to avoid re-inserting old ones.
          const turns = (message['messages'] as Array<Record<string, unknown>> | undefined) ?? [];
          logger.debug({ vapiCallId, turnCount: turns.length }, '[vapi/inbound] conversation-update: raw turns received');
          const existingCount = (db.prepare(`SELECT COUNT(*) as n FROM call_transcripts WHERE vapi_call_id = ?`).get(vapiCallId) as { n: number })?.n ?? 0;

          const pushFn = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
          let inserted = 0;

          // Normalize role: Vapi may send 'assistant' or 'bot' for AI turns; 'user' for human turns
          const normalizeRole = (r: string): 'assistant' | 'user' => {
            if (r === 'assistant' || r === 'bot' || r === 'ai') return 'assistant';
            return 'user';
          };

          // Filter to turns that have text content
          const contentTurns = turns.filter(t => {
            const text = ((t['message'] as string | undefined) ?? (t['content'] as string | undefined) ?? '').trim();
            return text.length > 0;
          });

          // Insert turns we haven't saved yet (diff by count — conversation-update is cumulative)
          if (contentTurns.length > existingCount) {
            const newTurns = contentTurns.slice(existingCount);
            for (const turn of newTurns) {
              const rawRole = (turn['role'] as string | undefined) ?? 'user';
              const role = normalizeRole(rawRole);
              const text = ((turn['message'] as string | undefined) ?? (turn['content'] as string | undefined) ?? '').trim();
              if (!text) continue;
              const result = db.prepare(
                `INSERT INTO call_transcripts (call_id, vapi_call_id, role, text, is_final, created_at) VALUES (?, ?, ?, ?, 1, datetime('now'))`
              ).run(callRow.id, vapiCallId, role, text);
              const newRow = {
                id: result.lastInsertRowid,
                call_id: callRow.id,
                vapi_call_id: vapiCallId,
                role,
                text,
                is_final: 1,
                created_at: new Date().toISOString(),
              };
              if (pushFn) {
                pushFn(`data: ${JSON.stringify({ type: 'call_transcript', rows: [newRow] })}\n\n`);
              }
              inserted++;
            }
            if (inserted > 0) {
              logger.info({ vapiCallId, inserted, total: contentTurns.length }, '[vapi/inbound] conversation-update: transcript turns saved');
            }
          }
        } catch (convErr) {
          logger.warn({ err: convErr }, '[vapi/inbound] failed to process conversation-update transcript');
        }
        return res.json({ ok: true });
      }

      res.json({ ok: true, ignored: true });
    } catch (err) {
      logger.error({ err }, '[vapi/inbound] error');
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/vapi/webhook — Vapi end-of-call webhook
  // Vapi posts this when a call ends with full transcript, duration, and result
  app.post('/api/vapi/webhook', async (req: Request, res: Response) => {
    try {
      // HMAC verification
      if (!verifyVapiSignature(req)) {
        logger.warn('[vapi/webhook] Invalid signature — rejected');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const msgType = (body['message'] as Record<string, unknown>)?.['type'] as string | undefined
        ?? body['type'] as string | undefined;

      // Handle status-update (inbound call started mid-flow)
      if (msgType === 'status-update') {
        res.json({ ok: true, ignored: true });
        return;
      }

      // Only process end-of-call-report
      if (msgType !== 'end-of-call-report') {
        res.json({ ok: true, ignored: true });
        return;
      }

      const msg = (body['message'] ?? body) as Record<string, unknown>;
      const callObj = msg['call'] as Record<string, unknown> | undefined ?? msg;
      const vapiCallId = callObj['id'] as string | undefined ?? msg['callId'] as string | undefined;
      const endedReason = (msg['endedReason'] ?? callObj['endedReason']) as string | undefined;
      const rawDurationMs = (msg['durationMs'] as number | undefined) ?? 0;
      const durationSeconds = Math.round(rawDurationMs / 1000) || ((msg['durationSeconds'] as number | undefined) ?? 0);

      // Extract transcript — Vapi sends structured artifact
      const artifact = msg['artifact'] as Record<string, unknown> | undefined;
      let transcriptText: string | null = null;
      if (artifact?.['transcript']) {
        transcriptText = String(artifact['transcript']);
      } else if (artifact?.['messages']) {
        const msgs = artifact['messages'] as Array<{ role: string; message?: string; content?: string }>;
        transcriptText = JSON.stringify(
          msgs.map(m => ({ speaker: m.role === 'assistant' ? 'ai' : 'contact', text: m.message ?? m.content ?? '' }))
        );
      }

      // Determine outcome
      const succeeded = endedReason === 'assistant-ended-call' || endedReason === 'customer-ended-call';
      const missed = endedReason === 'no-answer' || endedReason === 'busy';
      const voicemail = endedReason === 'voicemail';
      const newStatus = missed ? 'missed' : voicemail ? 'voicemail' : succeeded ? 'answered' : 'missed';
      // Compute proper outcome value for dashboard badges
      const eocFailedReasons = ['no-answer', 'busy', 'silence-timed-out', 'customer-did-not-answer'];
      const eocPartialReasons = ['voicemail', 'max-duration-exceeded'];
      const objAchievedEoc = succeeded ? 1 : 0;
      const outcomeVal = eocFailedReasons.includes(endedReason ?? '') ? 'failed'
        : eocPartialReasons.includes(endedReason ?? '') ? 'partial'
        : succeeded ? 'success' : 'partial';
      // Human-readable summary
      const eocSummaryMap: Record<string, string> = { 'customer-ended-call': 'Completada', 'assistant-ended-call': 'Completada', 'no-answer': 'No contestó', 'busy': 'Línea ocupada', 'voicemail': 'Buzón de voz', 'silence-timed-out': 'Sin respuesta', 'max-duration-exceeded': 'Duración máxima alcanzada' };
      const eocSummary = eocSummaryMap[endedReason ?? ''] ?? endedReason ?? 'Desconocido';

      // Find the call record by vapi_call_id or fall back to most recent queued call
      let callRow = vapiCallId
        ? db.prepare(`SELECT id, contact_name FROM calls WHERE vapi_call_id = ? LIMIT 1`).get(vapiCallId) as { id: string; contact_name?: string } | undefined
        : undefined;
      if (!callRow) {
        callRow = db.prepare(`SELECT id, contact_name FROM calls WHERE status = 'queued' ORDER BY created_at DESC LIMIT 1`).get() as { id: string; contact_name?: string } | undefined;
      }

      if (callRow) {
        db.prepare(`
          UPDATE calls SET
            status = ?,
            duration_seconds = ?,
            transcript = ?,
            ended_at = datetime('now'),
            ended_reason = ?,
            objective_achieved = ?,
            outcome = ?,
            summary = ?
          WHERE id = ?
        `).run(newStatus, durationSeconds, transcriptText, endedReason ?? null, objAchievedEoc, outcomeVal, eocSummary, callRow.id);
      } else if (vapiCallId) {
        // Create a new record if we have no matching call
        const id = `call-${Date.now()}-webhook`;
        db.prepare(`
          INSERT INTO calls (id, vapi_call_id, to_number, status, duration_seconds, transcript, ended_at, ended_reason, objective_achieved, outcome, summary, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'))
        `).run(id, vapiCallId, 'unknown', newStatus, durationSeconds, transcriptText, endedReason ?? null, objAchievedEoc, outcomeVal, eocSummary);
      }

      // Log activity
      db.prepare(`
        INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
        VALUES ('thorn', 'Thorn', '🌵', ?, 'success', 'executive', datetime('now'))
      `).run(`Llamada terminada — ${newStatus}${durationSeconds ? `, ${durationSeconds}s` : ''}`);

      // Reset Thorn's status back to active now that the call is over
      db.prepare(`UPDATE agents SET status = 'active', current_task = NULL, updated_at = unixepoch() WHERE id = 'thorn' AND status = 'working'`).run();

      // Immediate SSE push so dashboard updates without waiting for 1s poll
      cacheInvalidate('calls');
      const pushFnEoc = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
      if (pushFnEoc) {
        const vapiCallIdForPush = vapiCallId ?? '';
        pushFnEoc(`data: ${JSON.stringify({ type: 'call_ended', vapiCallId: vapiCallIdForPush, outcome: outcomeVal })}\n\n`);
        const allCallsEoc = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
        pushFnEoc(`data: ${JSON.stringify({ type: 'calls', rows: allCallsEoc })}\n\n`);
      }

      // Post-call processor: auto-process any action items Gonzalo requested via the real Thorn pipeline
      // Runs even if Vapi AI failed to call delegate_to_thorn during the call
      void (async () => {
        try {
          const webhookCallRow2 = callRow;
          if (!webhookCallRow2) return;
          const webhookTranscripts = db.prepare(
            `SELECT role, text FROM call_transcripts WHERE call_id = ? ORDER BY id ASC`
          ).all(webhookCallRow2.id) as Array<{ role: string; text: string }>;

          // Fall back to raw transcript text if no structured rows
          let webhookConversation = webhookTranscripts.length > 0
            ? webhookTranscripts.map((t) => `${t.role === 'user' ? 'Gonzalo' : 'Thorn'}: ${t.text}`).join('\n')
            : transcriptText ?? '';

          if (!webhookConversation.trim()) return;

          // Save call transcript to cross-platform memory so Telegram/VisionClaw share context
          saveCrossPlatformConversationTurn(
            `Llamada telefónica con Thorn — ${webhookCallRow2.contact_name ?? 'Gonzalo'}`,
            webhookConversation,
            webhookCallRow2.id
          );

          const webhookPostCallPrompt = `[Resumen de llamada telefónica - procesamiento de tareas pendientes]

Esta es la transcripción de una llamada que acaba de terminar entre Gonzalo y Thorn (el asistente de voz):

${webhookConversation}

Tu tarea: Identifica CUALQUIER acción que Gonzalo haya solicitado durante esta llamada que no haya sido completada. Si hay tareas pendientes, ejecútalas ahora exactamente igual que si Gonzalo te las hubiera enviado por Telegram. Si todo ya fue atendido durante la llamada o no hay acciones pendientes, no envíes ningún mensaje.`;

          const webhookPostCallRes = await fetch('http://localhost:3001/api/agents/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: 'thorn', task: webhookPostCallPrompt }),
          });
          if (webhookPostCallRes.ok) {
            logger.info({ callId: webhookCallRow2.id }, '[vapi/webhook] post-call processor queued');
          } else {
            logger.warn({ status: webhookPostCallRes.status }, '[vapi/webhook] post-call processor failed to queue');
          }
        } catch (webhookPostCallErr) {
          logger.error({ err: webhookPostCallErr }, '[vapi/webhook] post-call processor error');
        }
      })();

      res.json({ ok: true });
    } catch (err) {
      console.error('[Vapi webhook]', err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/recordings', (_req: Request, res: Response) => {
    try {
      const limit = Math.min(Number((_req.query as Record<string, string>)['limit']) || 50, 100);
      const rows = db.prepare(`SELECT * FROM recordings ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;

      // Enrich with linked meeting data (single batch query)
      const meetingIds = rows.map((r) => r['meeting_id'] as string).filter(Boolean);
      let meetingMap = new Map<string, Record<string, unknown>>();
      if (meetingIds.length > 0) {
        const placeholders = meetingIds.map(() => '?').join(',');
        const meetings = db.prepare(`SELECT id, topic, status, start_time, end_time, gonzalo_present FROM agent_meetings WHERE id IN (${placeholders})`).all(...meetingIds) as Array<Record<string, unknown>>;
        for (const m of meetings) meetingMap.set(m['id'] as string, m);
      }

      const enriched = rows.map((rec) => ({
        ...rec,
        meeting: rec['meeting_id'] ? (meetingMap.get(rec['meeting_id'] as string) ?? null) : null,
      }));

      res.json({ recordings: enriched });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/recordings/active — returns currently active live recording (for homepage indicator)
  app.get('/api/recordings/active', (_req: Request, res: Response) => {
    try {
      const row = db.prepare(`SELECT * FROM live_recordings WHERE status = 'recording' ORDER BY started_at DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
      if (!row) { res.json(null); return; }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/live-recordings — list all live recording sessions
  app.get('/api/live-recordings', (_req: Request, res: Response) => {
    try {
      const limit = Math.min(Number((_req.query as Record<string, string>)['limit']) || 50, 100);
      const rows = db.prepare(`SELECT * FROM live_recordings ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/start — create a new live recording session
  app.post('/api/recordings/start', (req: Request, res: Response) => {
    try {
      const { title, participants, meeting_id, meeting_type } = req.body as { title?: string; participants?: string[]; meeting_id?: string; meeting_type?: string };
      const id = `lrec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const recTitle = title?.trim() || `Meeting — ${new Date().toLocaleDateString('es-MX', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      const recMeetingType = meeting_type || 'general';
      db.prepare(`
        INSERT INTO live_recordings (id, title, status, started_at, transcript, live_summary, live_minutes, live_tasks, participants, meeting_id, meeting_type, created_at)
        VALUES (?, ?, 'recording', datetime('now'), '', '', '', '[]', ?, ?, ?, datetime('now'))
      `).run(id, recTitle, JSON.stringify(participants ?? []), meeting_id || null, recMeetingType);
      // Log activity
      db.prepare(`INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','Grabación iniciada: ${recTitle}','info','executive',datetime('now'))`).run();
      res.json({ ok: true, id, title: recTitle });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/:id/transcript — append transcript chunk
  app.post('/api/recordings/:id/transcript', (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const { text } = req.body as { text: string };
      if (!text) { res.status(400).json({ error: 'text required' }); return; }
      // Append to transcript with newline separator
      db.prepare(`UPDATE live_recordings SET transcript = transcript || ? WHERE id = ? AND status = 'recording'`).run('\n' + text, id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/recordings/:id/live — get current live recording state (transcript + live notes)
  app.get('/api/recordings/:id/live', (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const row = db.prepare(`SELECT id, title, status, started_at, transcript, live_summary, live_minutes, live_tasks, participants FROM live_recordings WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) { res.status(404).json({ error: 'Recording not found' }); return; }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/:id/ai-update — trigger AI to analyze transcript so far and update live notes
  app.post('/api/recordings/:id/ai-update', async (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const row = db.prepare(`SELECT transcript, title FROM live_recordings WHERE id = ? AND status = 'recording'`).get(id) as { transcript: string; title: string } | undefined;
      if (!row || !row.transcript || row.transcript.trim().length < 50) {
        res.json({ ok: true, message: 'Not enough transcript yet' });
        return;
      }

      // Use runAgent (OAuth) instead of direct API key
      const aiPrompt = `IMPORTANT: Respond entirely in the same language as the transcript. If the transcript is in Spanish, respond in Spanish. If in English, respond in English. If mixed, use the dominant language. Never default to English.

Analyze this PARTIAL meeting transcript (still recording) and produce a live summary. Be concise. Do not use any tools — just reply with text in the exact format below.

Transcript so far:
${row.transcript.slice(-3000)}

Respond in this exact format:
LIVE_SUMMARY:
[2-3 bullet points of what has been discussed so far]

LIVE_TASKS:
["action item 1", "action item 2"]`;

      try {
        const aiResult = await runAgent(aiPrompt, undefined, () => {});
        const raw = aiResult.text || '';
        const summaryMatch = raw.match(/LIVE_SUMMARY:\s*([\s\S]*?)(?=\nLIVE_TASKS:|$)/);
        const tasksMatch = raw.match(/LIVE_TASKS:\s*([\s\S]*?)$/);
        const liveSummary = summaryMatch?.[1]?.trim() || '';
        let liveTasks: string[] = [];
        try { liveTasks = JSON.parse(tasksMatch?.[1]?.trim() || '[]') as string[]; } catch (_) {}
        if (liveSummary) {
          db.prepare(`UPDATE live_recordings SET live_summary = ?, live_tasks = ? WHERE id = ?`).run(liveSummary, JSON.stringify(liveTasks), id);
        }
      } catch (aiErr) {
        logger.error({ err: aiErr }, 'ai-update: runAgent failed');
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/:id/stop — stop recording, trigger full processing, generate PDF
  app.post('/api/recordings/:id/stop', async (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const row = db.prepare(`SELECT * FROM live_recordings WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) { res.status(404).json({ error: 'Recording not found' }); return; }
      if (row['status'] !== 'recording') { res.json({ ok: true, message: 'Already stopped' }); return; }

      // Mark as processing
      db.prepare(`UPDATE live_recordings SET status = 'processing', ended_at = datetime('now') WHERE id = ?`).run(id);

      // Respond immediately so frontend doesn't wait
      res.json({ ok: true, id });

      // Run processing in background (fire and forget)
      void (async () => {
        try {
          const transcript = (row['transcript'] as string) || '';
          const title = (row['title'] as string) || 'Meeting';
          const startedAt = (row['started_at'] as string) || '';
          const endedAt = new Date().toISOString();
          const meetingTypeStop = (row['meeting_type'] as string) || 'general';

          const meetingTypeContextMap: Record<string, string> = {
            general: 'General meeting. Focus on decisions and next steps.',
            strategy: 'Strategy/Business meeting. Focus on decisions, roadmap items, and strategic direction.',
            technical: 'Technical meeting. Focus on implementation details, blockers, and architectural decisions.',
            client: 'Client/Commercial meeting. Focus on commitments made, deliverables, and next steps for the client relationship.',
            financial: 'Financial meeting. Focus on numbers, budget decisions, and financial commitments.',
          };
          const meetingTypeAgentMap: Record<string, string[]> = {
            general: ['Aria (Strategy)', 'Maya (Ops)'],
            strategy: ['Aria (Strategy)', 'Maya (Ops)', 'Jordan (Finance)'],
            technical: ['Marcus (Engineering)', 'Aria (Strategy)'],
            client: ['Sofia (Content)', 'Maya (Ops)', 'Aria (Strategy)'],
            financial: ['Jordan (Finance)', 'Aria (Strategy)', 'Maya (Ops)'],
          };
          const meetingTypeContext = meetingTypeContextMap[meetingTypeStop] || meetingTypeContextMap['general'];
          const activeAgentNames = (meetingTypeAgentMap[meetingTypeStop] || meetingTypeAgentMap['general']).join(', ');

          let summary = '';
          let minutes = '';
          let tasks: string[] = [];

          if (transcript.trim().length > 20) {
            // Use runAgent (OAuth) for Claude analysis — no ANTHROPIC_API_KEY needed
            const analysisPrompt = `IMPORTANT: Respond entirely in the same language as the transcript. If the transcript is in Spanish, respond in Spanish. If in English, respond in English. If mixed, use the dominant language. Never default to English.

Analyze this meeting transcript and produce complete meeting documentation. Do not use any tools — just reply with text in the exact format below.

Meeting: ${title}
Date: ${new Date(startedAt).toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Meeting Type: ${meetingTypeStop}
Context: ${meetingTypeContext}
Active Agents: ${activeAgentNames}

Transcript:
${transcript.slice(0, 40000)}

Respond in this exact format:
SUMMARY:
[3-5 bullet point executive summary covering the most important outcomes]

MINUTES:
[Comprehensive structured meeting minutes with these sections:
- Participantes: list everyone who spoke or was mentioned
- Temas discutidos: each topic with key points and what was said
- Decisiones tomadas: every concrete decision, with who made it
- Compromisos específicos: exact commitments made by each person
- Próximos pasos: what needs to happen next, by whom, by when]

ACTION_ITEMS:
["action item — Owner: Name, Deadline: date if mentioned", "action item 2"]`;

            try {
              const analysisResult = await runAgent(analysisPrompt, undefined, () => {});
              const raw = analysisResult.text || '';
              const summaryMatch = raw.match(/SUMMARY:\s*([\s\S]*?)(?=\nMINUTES:|$)/);
              const minutesMatch = raw.match(/MINUTES:\s*([\s\S]*?)(?=\nACTION_ITEMS:|$)/);
              const tasksMatch = raw.match(/ACTION_ITEMS:\s*([\s\S]*?)$/);
              summary = summaryMatch?.[1]?.trim() || '';
              minutes = minutesMatch?.[1]?.trim() || '';
              try { tasks = JSON.parse(tasksMatch?.[1]?.trim() || '[]') as string[]; } catch (_) { tasks = []; }
            } catch (aiErr) {
              logger.error({ err: aiErr }, 'stop recording: runAgent analysis failed');
            }
          }

          // Fallback
          if (!summary && transcript) { summary = transcript.slice(0, 300); }

          // Generate PDF using puppeteer
          let documentPath = '';
          try {
            const { execSync: execSyncPdf } = await import('child_process');
            const pathMod = await import('path');
            const fsSync = await import('fs');

            const meetingsDir = '/Users/opoclaw1/claudeclaw/workspace/meetings';
            if (!fsSync.existsSync(meetingsDir)) { fsSync.mkdirSync(meetingsDir, { recursive: true }); }

            const safeId = id.replace(/[^a-zA-Z0-9-]/g, '-');
            const pdfPath = pathMod.join(meetingsDir, `${safeId}.pdf`);

            const now = new Date(startedAt);
            const dateStr = now.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            const durationSecs = Math.round((new Date(endedAt).getTime() - now.getTime()) / 1000);
            const durationStr = durationSecs < 3600
              ? `${Math.floor(durationSecs / 60)} min`
              : `${Math.floor(durationSecs / 3600)}h ${Math.floor((durationSecs % 3600) / 60)}min`;

            const tasksHtml = tasks.length > 0
              ? `<ol style="margin:0;padding-left:18px;">${tasks.map(t => `<li style="margin-bottom:4px;color:#333;">${t}</li>`).join('')}</ol>`
              : '<p style="color:#666;font-style:italic;">No action items detected.</p>';

            const htmlContent = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body{font-family:Helvetica,Arial,sans-serif;margin:0;padding:40px;color:#111;background:#fff;font-size:13px;line-height:1.6;}
  .header{border-bottom:3px solid #0066CC;padding-bottom:20px;margin-bottom:28px;}
  .logo{font-size:22px;font-weight:800;color:#0066CC;letter-spacing:-0.5px;}
  .subtitle{color:#666;font-size:11px;margin-top:4px;text-transform:uppercase;letter-spacing:0.05em;}
  h1{font-size:20px;font-weight:700;margin:0 0 6px;color:#111;}
  .meta{color:#666;font-size:11px;display:flex;gap:20px;margin-top:8px;flex-wrap:wrap;}
  .section{margin-bottom:24px;}
  .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#0066CC;border-bottom:1px solid #E5E7EB;padding-bottom:6px;margin-bottom:12px;}
  .summary-box{background:#F0F7FF;border:1px solid #CCE0FF;border-radius:6px;padding:14px;margin-bottom:0;}
  .minutes-box{background:#FAFAFA;border:1px solid #E5E7EB;border-radius:6px;padding:14px;white-space:pre-wrap;font-size:12px;}
  .tasks-box{background:#FFF8F0;border:1px solid #FFD9A0;border-radius:6px;padding:14px;}
  .transcript-box{background:#FAFAFA;border:1px solid #E5E7EB;border-radius:6px;padding:14px;white-space:pre-wrap;font-size:11px;max-height:none;color:#444;}
  .footer{margin-top:40px;border-top:1px solid #E5E7EB;padding-top:14px;color:#999;font-size:10px;display:flex;justify-content:space-between;}
</style></head>
<body>
  <div class="header">
    <div class="logo">OpoClaw</div>
    <div class="subtitle">Meeting Intelligence System — Confidential</div>
  </div>

  <div class="section">
    <h1>${title}</h1>
    <div class="meta">
      <span>Date: ${dateStr}</span>
      <span>Time: ${timeStr}</span>
      <span>Duration: ${durationStr}</span>
      <span>ID: ${id}</span>
    </div>
  </div>

  ${summary ? `<div class="section">
    <div class="section-title">Executive Summary</div>
    <div class="summary-box">${summary.replace(/\n/g, '<br>')}</div>
  </div>` : ''}

  ${minutes ? `<div class="section">
    <div class="section-title">Meeting Minutes</div>
    <div class="minutes-box">${minutes}</div>
  </div>` : ''}

  ${tasks.length > 0 ? `<div class="section">
    <div class="section-title">Action Items (${tasks.length})</div>
    <div class="tasks-box">${tasksHtml}</div>
  </div>` : ''}

  ${transcript ? `<div class="section">
    <div class="section-title">Full Transcript</div>
    <div class="transcript-box">${transcript.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>
  </div>` : ''}

  <div class="footer">
    <span>Generated by OpoClaw — Meeting Intelligence System</span>
    <span>${dateStr} ${timeStr}</span>
  </div>
</body>
</html>`;

            // Write HTML to temp file, then use puppeteer to convert to PDF
            const htmlPath = pdfPath.replace('.pdf', '.html');
            fsSync.writeFileSync(htmlPath, htmlContent, 'utf8');

            // Use puppeteer to generate PDF
            const puppeteer = (await import('puppeteer')).default;
            const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
            await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }, printBackground: true });
            await browser.close();

            // Clean up HTML temp file
            try { fsSync.unlinkSync(htmlPath); } catch (_) {}

            if (fsSync.existsSync(pdfPath)) {
              documentPath = pdfPath;
            }
          } catch (pdfErr) {
            logger.error({ err: pdfErr }, 'PDF generation failed');
            // Fallback to TXT if PDF fails
            const pathMod = await import('path');
            const fsSync = await import('fs');
            const meetingsDir = '/Users/opoclaw1/claudeclaw/workspace/meetings';
            if (!fsSync.existsSync(meetingsDir)) { fsSync.mkdirSync(meetingsDir, { recursive: true }); }
            const safeId = id.replace(/[^a-zA-Z0-9-]/g, '-');
            const txtPath = pathMod.join(meetingsDir, `${safeId}.txt`);
            const now = new Date(startedAt);
            const dateStr = now.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            const content = [
              'MINUTA DE REUNION — OPOCLAW', '='.repeat(50),
              `Titulo: ${title}`, `Fecha: ${dateStr}`, `Hora: ${timeStr}`, `ID: ${id}`, '',
              'RESUMEN EJECUTIVO', '-'.repeat(40), summary || 'Sin resumen.', '',
              'MINUTA', '-'.repeat(40), minutes || 'Sin minuta.', '',
              tasks.length > 0 ? ['ACCIONES PENDIENTES', '-'.repeat(40), ...tasks.map((t, i) => `${i + 1}. ${t}`)].join('\n') : '',
              '', 'TRANSCRIPCION COMPLETA', '-'.repeat(40), transcript || 'Sin transcripcion.',
            ].filter(Boolean).join('\n');
            fsSync.writeFileSync(txtPath, content, 'utf8');
            documentPath = txtPath;
          }

          // Update DB with final results
          db.prepare(`
            UPDATE live_recordings
            SET status = 'done', live_summary = ?, live_minutes = ?, live_tasks = ?, document_path = ?
            WHERE id = ?
          `).run(summary, minutes, JSON.stringify(tasks), documentPath, id);

          // Also create a regular recordings entry for the history view
          if (transcript) {
            const meetingId = row['meeting_id'] as string | null;
            const durationSecs = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
            try {
              db.prepare(`INSERT INTO recordings (meeting_id, transcript, minuta, summary, action_items, duration_secs, meeting_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(meetingId, transcript, minutes || transcript, summary, JSON.stringify(tasks), durationSecs, meetingTypeStop);
            } catch (_) {}
          }

          // Dispatch action items as real tasks on the board
          if (tasks.length > 0) {
            for (const taskTitle of tasks) {
              try {
                const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                db.prepare(`
                  INSERT INTO agent_tasks (id, title, description, assignee_id, assignee_name, assignee_emoji, department, priority, status, delegated_by, created_at, updated_at)
                  VALUES (?, ?, ?, 'maya-chen', 'Maya', '🌿', 'operations', 'medium', 'todo', 'thorn', datetime('now'), datetime('now'))
                `).run(taskId, taskTitle.slice(0, 200), `Tarea generada automáticamente de junta: ${title}`);
              } catch (_) {}
            }
            db.prepare(`INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','${tasks.length} tareas de junta enviadas al board','success','executive',datetime('now'))`).run();
          }

          // Log activity
          db.prepare(`INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('marcus-reyes','Marcus','🔧','Grabación finalizada y PDF generado: ${id}','success','engineering',datetime('now'))`).run();

          // Send PDF via Telegram
          if (documentPath) {
            const { exec } = await import('child_process');
            const isPdf = documentPath.endsWith('.pdf');
            const caption = isPdf ? 'Minuta completa (PDF)' : 'Minuta completa (TXT)';
            exec(
              `bash /Users/opoclaw1/claudeclaw/scripts/tg-send-doc.sh "${documentPath}" "${caption}"`,
              { timeout: 30000 },
              () => {}
            );

            // Wait 3 seconds, then ask about email recipients
            await new Promise<void>(resolve => setTimeout(resolve, 3000));
            const { exec: exec2 } = await import('child_process');
            const followupMsg = "Junta guardada. Quieres que envie el documento a algun correo de los participantes? Responde con los emails separados por coma, o di 'no' para saltar.";
            exec2(
              `bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "${followupMsg}"`,
              { timeout: 15000 },
              () => {}
            );

            // Store pending followup in DB
            db.prepare(`INSERT INTO pending_email_followups (recording_id, document_path, asked_at) VALUES (?, ?, datetime('now'))`).run(id, documentPath);
          }
        } catch (bgErr) {
          logger.error({ err: bgErr }, 'Background recording processing error');
          db.prepare(`UPDATE live_recordings SET status = 'error' WHERE id = ?`).run(id);
        }
      })();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/email-response — handle Gonzalo's email response for meeting docs
  app.post('/api/recordings/email-response', async (req: Request, res: Response) => {
    try {
      const { recording_id, emails } = req.body as { recording_id?: string; emails?: string };
      if (!emails || emails.toLowerCase().trim() === 'no') {
        // Clear pending followups
        if (recording_id) {
          db.prepare(`UPDATE pending_email_followups SET answered = 1 WHERE recording_id = ?`).run(recording_id);
        }
        res.json({ ok: true, message: 'Skipped email sending' });
        return;
      }

      // Get document path - either from specific recording or most recent pending
      let docPath = '';
      if (recording_id) {
        const pending = db.prepare(`SELECT document_path FROM pending_email_followups WHERE recording_id = ? ORDER BY asked_at DESC LIMIT 1`).get(recording_id) as { document_path: string } | undefined;
        docPath = pending?.document_path || '';
      } else {
        const pending = db.prepare(`SELECT document_path, recording_id FROM pending_email_followups WHERE answered = 0 ORDER BY asked_at DESC LIMIT 1`).get() as { document_path: string; recording_id: string } | undefined;
        if (pending) {
          docPath = pending.document_path;
          db.prepare(`UPDATE pending_email_followups SET answered = 1 WHERE recording_id = ?`).run(pending.recording_id);
        }
      }

      if (!docPath || !fs.existsSync(docPath)) {
        res.json({ ok: false, message: 'Document not found' });
        return;
      }

      // Send email via nodemailer (use opoclaw@gmail.com)
      const emailList = emails.split(',').map((e: string) => e.trim()).filter((e: string) => e.includes('@'));
      if (emailList.length === 0) { res.json({ ok: false, message: 'No valid emails' }); return; }

      // Use opoclaw@gmail.com via OAuth token if available
      const oauthRow = db.prepare(`SELECT access_token FROM oauth_tokens WHERE provider = 'gmail' LIMIT 1`).get() as { access_token: string } | undefined;
      if (oauthRow?.access_token) {
        for (const email of emailList) {
          try {
            const docName = path.basename(docPath);
            const outerBoundary = `outer_${Date.now()}`;
            const innerBoundary = `inner_${Date.now()}_alt`;
            const fileData = fs.readFileSync(docPath).toString('base64');
            const mimeType = docPath.endsWith('.pdf') ? 'application/pdf' : 'text/plain';
            const plainText = `Please find attached the meeting notes generated by OpoClaw.\n\n---\nOpoClaw | www.opoclaw.com | opoclaw@gmail.com`;
            const htmlText = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111111;"><div style="max-width:600px;padding:20px;"><p>Please find attached the meeting notes generated by OpoClaw.</p></div>${buildEmailSignature()}</body></html>`;
            const htmlBase64 = Buffer.from(htmlText, 'utf-8').toString('base64');
            const htmlChunked = htmlBase64.match(/.{1,76}/g)?.join('\r\n') || htmlBase64;
            const rawEmail = [
              `From: opoclaw@gmail.com`,
              `To: ${email}`,
              `Subject: Meeting Notes — OpoClaw`,
              `MIME-Version: 1.0`,
              `Content-Type: multipart/mixed; boundary="${outerBoundary}"`,
              '',
              `--${outerBoundary}`,
              `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
              '',
              `--${innerBoundary}`,
              `Content-Type: text/plain; charset=utf-8`,
              '',
              plainText,
              '',
              `--${innerBoundary}`,
              `Content-Type: text/html; charset=utf-8`,
              `Content-Transfer-Encoding: base64`,
              '',
              htmlChunked,
              '',
              `--${innerBoundary}--`,
              '',
              `--${outerBoundary}`,
              `Content-Type: ${mimeType}; name="${docName}"`,
              `Content-Disposition: attachment; filename="${docName}"`,
              `Content-Transfer-Encoding: base64`,
              '',
              fileData,
              `--${outerBoundary}--`,
            ].join('\r\n');
            const encoded = Buffer.from(rawEmail).toString('base64url');
            await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${oauthRow.access_token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ raw: encoded }),
            });
          } catch (emailErr) { logger.error({ err: emailErr }, 'Email send error'); }
        }
        const { exec } = await import('child_process');
        exec(`bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "Documento enviado a: ${emailList.join(', ')}"`, { timeout: 15000 }, () => {});
      } else {
        // Fallback: just notify that we can't send without OAuth
        const { exec } = await import('child_process');
        exec(`bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "No se pudo enviar por email — OAuth de Gmail no configurado. Emails solicitados: ${emailList.join(', ')}"`, { timeout: 15000 }, () => {});
      }

      if (recording_id) {
        db.prepare(`UPDATE pending_email_followups SET answered = 1 WHERE recording_id = ?`).run(recording_id);
      }
      res.json({ ok: true, sent_to: emailList });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/recordings/:id/emails — list all emails sent for a recording
  app.get('/api/recordings/:id/emails', (req: Request, res: Response) => {
    try {
      const recId = parseInt(String(req.params.id), 10);
      const rows = db.prepare('SELECT * FROM meeting_email_log WHERE recording_id = ? ORDER BY sent_at DESC').all(recId);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/:id/send-email — send meeting minutes to a list of emails and log it
  app.post('/api/recordings/:id/send-email', async (req: Request, res: Response) => {
    try {
      const recordingId = parseInt(String(req.params.id), 10);
      const { emails, meeting_id } = req.body as { emails: string[]; meeting_id?: string };
      if (!emails || emails.length === 0) { res.json({ ok: false, message: 'No emails provided' }); return; }

      // Get recording data (try both recordings and live_recordings tables)
      const rec = db.prepare(`SELECT * FROM recordings WHERE id = ?`).get(recordingId) as { id: number; meeting_id: string; summary: string; minuta: string; action_items: string; filename: string } | undefined;
      const liveRec = !rec
        ? (db.prepare(`SELECT * FROM live_recordings WHERE id = ? OR meeting_id = ?`).get(String(recordingId), String(meeting_id || '')) as { id: string; title: string; live_summary: string; live_minutes: string; document_path: string } | undefined)
        : undefined;

      const title = (rec as any)?.topic || liveRec?.title || 'Meeting';
      const summary = rec?.summary || liveRec?.live_summary || '';
      const minuta = rec?.minuta || liveRec?.live_minutes || '';
      const docPath = liveRec?.document_path || null;
      const dateStr = new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });

      const emailBody = [
        `Minuta de Reunion — ${title}`,
        `Fecha: ${dateStr}`,
        '',
        summary ? `Resumen:\n${summary}` : '',
        minuta ? `\nMinuta:\n${minuta}` : '',
      ].filter(Boolean).join('\n');

      const oauthRow = db.prepare(`SELECT access_token FROM oauth_tokens WHERE provider = 'gmail' LIMIT 1`).get() as { access_token: string } | undefined;
      const sentEmails: string[] = [];
      const failedEmails: string[] = [];

      for (const email of emails) {
        const trimmed = email.trim();
        if (!trimmed.includes('@')) continue;
        try {
          if (oauthRow?.access_token) {
            const emailHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111111;"><div style="max-width:600px;padding:20px;">${emailBody.replace(/\n/g, '<br/>')}</div>${buildEmailSignature()}</body></html>`;
            const emailHtmlBase64 = Buffer.from(emailHtml, 'utf-8').toString('base64');
            const emailHtmlChunked = emailHtmlBase64.match(/.{1,76}/g)?.join('\r\n') || emailHtmlBase64;
            const encodedSubject = `=?UTF-8?B?${Buffer.from(`Minuta: ${title} — ${dateStr}`, 'utf-8').toString('base64')}?=`;
            if (docPath && fs.existsSync(docPath)) {
              // Send with attachment
              const outerBoundary = `outer_${Date.now()}`;
              const innerBoundary = `inner_${Date.now()}_alt`;
              const docName = path.basename(docPath);
              const fileData = fs.readFileSync(docPath).toString('base64');
              const mimeType = docPath.endsWith('.pdf') ? 'application/pdf' : 'text/plain';
              const rawEmail = [
                `From: opoclaw@gmail.com`,
                `To: ${trimmed}`,
                `Subject: ${encodedSubject}`,
                `MIME-Version: 1.0`,
                `Content-Type: multipart/mixed; boundary="${outerBoundary}"`,
                '',
                `--${outerBoundary}`,
                `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
                '',
                `--${innerBoundary}`,
                `Content-Type: text/plain; charset=utf-8`,
                '',
                emailBody,
                `\n---\nOpoClaw | www.opoclaw.com | opoclaw@gmail.com`,
                '',
                `--${innerBoundary}`,
                `Content-Type: text/html; charset=utf-8`,
                `Content-Transfer-Encoding: base64`,
                '',
                emailHtmlChunked,
                '',
                `--${innerBoundary}--`,
                '',
                `--${outerBoundary}`,
                `Content-Type: ${mimeType}; name="${docName}"`,
                `Content-Disposition: attachment; filename="${docName}"`,
                `Content-Transfer-Encoding: base64`,
                '',
                fileData,
                `--${outerBoundary}--`,
              ].join('\r\n');
              const encoded = Buffer.from(rawEmail).toString('base64url');
              await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${oauthRow.access_token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw: encoded }),
              });
            } else {
              // Send HTML-only (no attachment)
              const innerBoundary = `inner_${Date.now()}_alt`;
              const rawEmail = [
                `From: opoclaw@gmail.com`,
                `To: ${trimmed}`,
                `Subject: ${encodedSubject}`,
                `MIME-Version: 1.0`,
                `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
                '',
                `--${innerBoundary}`,
                `Content-Type: text/plain; charset=utf-8`,
                '',
                emailBody,
                `\n---\nOpoClaw | www.opoclaw.com | opoclaw@gmail.com`,
                '',
                `--${innerBoundary}`,
                `Content-Type: text/html; charset=utf-8`,
                `Content-Transfer-Encoding: base64`,
                '',
                emailHtmlChunked,
                '',
                `--${innerBoundary}--`,
              ].join('\r\n');
              const encoded = Buffer.from(rawEmail).toString('base64url');
              await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${oauthRow.access_token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw: encoded }),
              });
            }
            // Log successful send
            db.prepare(`INSERT INTO meeting_email_log (recording_id, meeting_id, email, sent_at, status, sent_by) VALUES (?, ?, ?, datetime('now'), 'sent', 'manual')`).run(recordingId, meeting_id || null, trimmed);
            sentEmails.push(trimmed);
          } else {
            // Log as failed (no OAuth)
            db.prepare(`INSERT INTO meeting_email_log (recording_id, meeting_id, email, sent_at, status, sent_by) VALUES (?, ?, ?, datetime('now'), 'failed', 'manual')`).run(recordingId, meeting_id || null, trimmed);
            failedEmails.push(trimmed);
          }
        } catch (emailErr) {
          logger.error({ err: emailErr }, 'Email send error');
          db.prepare(`INSERT INTO meeting_email_log (recording_id, meeting_id, email, sent_at, status, sent_by) VALUES (?, ?, ?, datetime('now'), 'failed', 'manual')`).run(recordingId, meeting_id || null, trimmed);
          failedEmails.push(trimmed);
        }
      }

      res.json({ ok: true, sent: sentEmails, failed: failedEmails });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings — receive audio blob, transcribe via Whisper, analyze with Claude
  app.post('/api/recordings', async (req: Request, res: Response) => {
    try {
      const multer = (await import('multer')).default;
      // Allow up to 500MB — supports 1-2 hour recordings at typical browser bitrates
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

      upload.single('audio')(req, res, async (err) => {
        if (err) { res.status(400).json({ error: String(err) }); return; }

        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) { res.status(400).json({ error: 'No audio file uploaded' }); return; }

        const durationSecs = parseInt(String(req.body['durationSecs'] || '0'), 10);
        const meetingId = req.body['meetingId'] as string | undefined;
        const meetingTypeUpload = (req.body['meetingType'] as string) || 'general';

        // Set SSE headers for streaming updates
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.flushHeaders();

        const send = (obj: object) => {
          try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {}
        };

        // Helper: transcribe a single buffer via Whisper with a 10-minute timeout
        const transcribeBuffer = async (buf: Buffer, ext: string, lang: string, openaiKey: string): Promise<string> => {
          const FormDataNode = (await import('form-data')).default;
          const fd = new FormDataNode();
          fd.append('file', buf, { filename: `chunk.${ext}`, contentType: `audio/${ext}` });
          fd.append('model', 'whisper-1');
          fd.append('language', lang);

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 min per chunk
          try {
            const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${openaiKey}`, ...fd.getHeaders() },
              body: fd.getBuffer(),
              signal: controller.signal,
            });
            if (!r.ok) { throw new Error(`Whisper HTTP ${r.status}: ${await r.text()}`); }
            const data = await r.json() as { text?: string };
            return data.text?.trim() || '';
          } finally {
            clearTimeout(timer);
          }
        };

        try {
          // ── Step 1: Transcribe via OpenAI Whisper ─────────────────
          send({ status: 'transcribing', message: 'Sending to Whisper...' });

          const openaiKey = process.env['OPENAI_API_KEY'] || '';
          if (!openaiKey) {
            send({ status: 'error', error: 'OPENAI_API_KEY not configured' });
            res.end();
            return;
          }

          const ext = file.mimetype?.includes('mp4') ? 'mp4' : file.mimetype?.includes('ogg') ? 'ogg' : file.mimetype?.includes('wav') ? 'wav' : 'webm';
          const lang = (req.body['lang'] as string) || 'es';

          // Whisper hard limit is 25MB. If file exceeds it, split into 10-minute chunks via ffmpeg.
          const WHISPER_LIMIT = 24 * 1024 * 1024; // 24MB safety margin
          let transcript = '';

          if (file.buffer.length <= WHISPER_LIMIT) {
            // Small file — send directly
            transcript = await transcribeBuffer(file.buffer, ext, lang, openaiKey);
          } else {
            // Large file — write to temp, chunk with ffmpeg, transcribe each chunk
            send({ status: 'transcribing', message: `File is ${Math.round(file.buffer.length / 1024 / 1024)}MB — splitting into chunks for Whisper...` });
            const os = await import('os');
            const fsSync = await import('fs');
            const pathMod = await import('path');
            const { execSync: execSyncLocal } = await import('child_process');

            const tmpDir = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'rec-'));
            const inputPath = pathMod.join(tmpDir, `input.${ext}`);
            fsSync.writeFileSync(inputPath, file.buffer);

            // Split into 10-minute segments (-c copy = no re-encode, fast)
            const chunkPattern = pathMod.join(tmpDir, 'chunk_%03d.webm');
            let chunkExt = 'webm';
            let chunkGlob = 'webm';
            try {
              execSyncLocal(
                `ffmpeg -i "${inputPath}" -f segment -segment_time 600 -c copy "${chunkPattern}" -y`,
                { stdio: 'pipe', timeout: 5 * 60 * 1000 }
              );
            } catch (_ffmpegCopyErr) {
              // copy failed (format unsupported) — re-encode to mp3 (universally supported)
              chunkExt = 'mp3';
              chunkGlob = 'mp3';
              const mp3Pattern = pathMod.join(tmpDir, 'chunk_%03d.mp3');
              execSyncLocal(
                `ffmpeg -i "${inputPath}" -f segment -segment_time 600 -ac 1 -ar 16000 "${mp3Pattern}" -y`,
                { stdio: 'pipe', timeout: 10 * 60 * 1000 }
              );
            }

            const chunkFiles = fsSync.readdirSync(tmpDir)
              .filter(f => f.startsWith('chunk_') && f.endsWith(`.${chunkGlob}`))
              .sort();
            const parts: string[] = [];
            for (let i = 0; i < chunkFiles.length; i++) {
              send({ status: 'transcribing', message: `Transcribing part ${i + 1} of ${chunkFiles.length}...` });
              const chunkBuf = fsSync.readFileSync(pathMod.join(tmpDir, chunkFiles[i]));
              parts.push(await transcribeBuffer(chunkBuf, chunkExt, lang, openaiKey));
            }
            transcript = parts.join(' ');
            try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
          }

          send({ status: 'transcribed', transcript });

          // ── Step 2: Analyze with Claude ───────────────────────────
          send({ status: 'processing', message: 'Analyzing with Claude...' });

          let minuta = '';
          let summary = '';
          let actionItems: string[] = [];

          if (transcript) {
            // Use runAgent (OAuth) for Claude analysis — no ANTHROPIC_API_KEY needed
            const meetingTypeContextMapUpload: Record<string, string> = {
              general: 'General meeting. Focus on decisions and next steps.',
              strategy: 'Strategy/Business meeting. Focus on decisions, roadmap items, and strategic direction.',
              technical: 'Technical meeting. Focus on implementation details, blockers, and architectural decisions.',
              client: 'Client/Commercial meeting. Focus on commitments made, deliverables, and next steps for the client relationship.',
              financial: 'Financial meeting. Focus on numbers, budget decisions, and financial commitments.',
            };
            const meetingTypeAgentMapUpload: Record<string, string[]> = {
              general: ['Aria (Strategy)', 'Maya (Ops)'],
              strategy: ['Aria (Strategy)', 'Maya (Ops)', 'Jordan (Finance)'],
              technical: ['Marcus (Engineering)', 'Aria (Strategy)'],
              client: ['Sofia (Content)', 'Maya (Ops)', 'Aria (Strategy)'],
              financial: ['Jordan (Finance)', 'Aria (Strategy)', 'Maya (Ops)'],
            };
            const uploadMeetingTypeContext = meetingTypeContextMapUpload[meetingTypeUpload] || meetingTypeContextMapUpload['general'];
            const uploadActiveAgentNames = (meetingTypeAgentMapUpload[meetingTypeUpload] || meetingTypeAgentMapUpload['general']).join(', ');

            const notesPrompt = `IMPORTANT: Respond entirely in the same language as the transcript. If the transcript is in Spanish, respond in Spanish. If in English, respond in English. If mixed, use the dominant language. Never default to English.

Analyze this meeting transcript and produce structured meeting documentation. Do not use any tools — just reply with text in the exact format below.

Meeting Type: ${meetingTypeUpload}
Context: ${uploadMeetingTypeContext}
Active Agents: ${uploadActiveAgentNames}

Transcript:
${transcript.slice(0, 40000)}

Respond in this exact format:
MEETING_NOTES:
[Comprehensive structured notes with these sections:
- Participantes: everyone who spoke or was mentioned
- Temas discutidos: each topic covered with key points
- Decisiones tomadas: every concrete decision made, by whom
- Compromisos específicos: exact commitments per person
- Próximos pasos: what needs to happen next, owner, deadline if mentioned]

SUMMARY:
[3-5 bullet executive summary of the most important outcomes]

ACTION_ITEMS:
["item 1 — Owner: Name, Deadline: date if mentioned", "item 2", ...]`;

            try {
              const notesResult = await runAgent(notesPrompt, undefined, () => {});
              const rawText = notesResult.text || '';

              // Parse sections
              const notesMatch = rawText.match(/MEETING_NOTES:\s*([\s\S]*?)(?=\nSUMMARY:|$)/);
              const summaryMatch = rawText.match(/SUMMARY:\s*([\s\S]*?)(?=\nACTION_ITEMS:|$)/);
              const actionMatch = rawText.match(/ACTION_ITEMS:\s*([\s\S]*?)$/);

              minuta = notesMatch?.[1]?.trim() || rawText;
              summary = summaryMatch?.[1]?.trim() || '';

              try {
                const actionText = actionMatch?.[1]?.trim() || '[]';
                actionItems = JSON.parse(actionText) as string[];
              } catch (_) {
                actionItems = [];
              }
            } catch (aiErr) {
              logger.error({ err: aiErr }, 'recordings POST: runAgent analysis failed');
            }
          }

          // Fallback: if Claude didn't produce notes, use transcript as-is
          if (!minuta && transcript) {
            minuta = transcript;
            summary = transcript.slice(0, 200);
          }

          send({ status: 'minuta', minuta });

          // ── Step 3: Save to DB ────────────────────────────────────
          const recResult = db.prepare(`
            INSERT INTO recordings (meeting_id, transcript, minuta, summary, action_items, duration_secs, meeting_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(meetingId || null, transcript, minuta, summary, JSON.stringify(actionItems), durationSecs, meetingTypeUpload);

          // Update meeting with transcript/notes/summary if meetingId provided
          if (meetingId) {
            db.prepare(`
              UPDATE agent_meetings
              SET transcript = ?, notes = ?, summary = ?, status = 'ended', end_time = datetime('now')
              WHERE id = ?
            `).run(transcript, minuta, summary, meetingId);

            // Add meeting notes as a live note for the meeting
            if (minuta) {
              db.prepare(`
                INSERT INTO meeting_live_notes (meeting_id, agent_id, content, created_at)
                VALUES (?, 'maya-chen', ?, datetime('now'))
              `).run(meetingId, minuta);
            }
          }

          // ── Step 4: Auto-create tasks from action items ───────────
          if (actionItems.length > 0) {
            for (const item of actionItems.slice(0, 10)) {
              const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              try {
                db.prepare(`
                  INSERT INTO agent_tasks (id, title, assignee_id, assignee_name, department, priority, status, created_at, updated_at)
                  VALUES (?, ?, 'maya-chen', 'Maya', 'operations', 'medium', 'pending', datetime('now'), datetime('now'))
                `).run(taskId, item);
              } catch (_) {
                // tasks table may have different schema — skip silently
              }
            }
          }

          // ── Step 5: Save to Brain vault ───────────────────────────
          const brainTitle = `Meeting Notes — ${new Date().toLocaleDateString('es-MX', { month: 'short', day: 'numeric', year: 'numeric' })}`;
          const brainContent = `# ${brainTitle}\n\n## Transcript\n${transcript}\n\n## Notes\n${minuta}\n\n## Summary\n${summary}`;
          try {
            db.prepare(`
              INSERT INTO brain_vault (title, content, type, agent_id, agent_name, department, tags, folder_path, created_at, updated_at)
              VALUES (?, ?, 'document', 'maya-chen', 'Maya', 'operations', 'meeting,recording', 'Meetings', datetime('now'), datetime('now'))
            `).run(brainTitle, brainContent);
          } catch (_) {}

          // ── Step 6: Post agent discussion to meeting chat ────────
          if (meetingId && minuta) {
            const agentNotes = [
              { agent_id: 'maya-chen', agent_name: 'Maya', msg: `Minuta lista. ${summary || 'Reunión transcrita y analizada.'}` },
              { agent_id: 'marcus-reyes', agent_name: 'Marcus', msg: actionItems.length > 0 ? `Detecté ${actionItems.length} acción(es) pendiente(s). Ya las creé como tareas.` : 'Sin tareas de acción detectadas en esta reunión.' },
            ];
            for (const n of agentNotes) {
              try {
                db.prepare(`INSERT INTO meeting_messages (meeting_id, agent_id, agent_name, content, message_type, created_at) VALUES (?, ?, ?, ?, 'answer', datetime('now'))`)
                  .run(meetingId, n.agent_id, n.agent_name, n.msg);
              } catch (_) {}
            }
          }

          // ── Step 7: Send "done" FIRST, then fire-and-forget Telegram notify ──
          // Critical: done must reach the client before any blocking shell call.
          send({ status: 'done', recordingId: recResult.lastInsertRowid });
          res.end();

          // Telegram: send meeting document + brief text message
          try {
            const { exec } = await import('child_process');
            const { writeFileSync } = await import('fs');
            const os = await import('os');
            const nodePath = await import('path');

            const now = new Date();
            const dateStr = now.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const timeStr = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

            const actionSection = actionItems.length > 0
              ? `\nACCIONES PENDIENTES (${actionItems.length})\n${'─'.repeat(40)}\n${actionItems.map((a: string, i: number) => `${i + 1}. ${a}`).join('\n')}`
              : `\nACCIONES PENDIENTES\n${'─'.repeat(40)}\nNinguna accion pendiente detectada.`;

            const docContent = [
              'MINUTA DE REUNION',
              '═'.repeat(50),
              `Fecha: ${dateStr}`,
              `Hora:  ${timeStr}`,
              `Duracion: ${Math.round(durationSecs / 60)} min`,
              meetingId ? `ID Reunion: ${meetingId}` : '',
              '',
              'RESUMEN EJECUTIVO',
              '─'.repeat(40),
              summary || 'Sin resumen disponible.',
              '',
              'NOTAS Y MINUTA',
              '─'.repeat(40),
              minuta || transcript || 'Sin notas disponibles.',
              actionSection,
              '',
              '─'.repeat(50),
              `Generado por OpoClaw · ${dateStr} ${timeStr}`,
            ].filter((l: string) => l !== undefined).join('\n');

            const safeDate = now.toISOString().slice(0, 10);
            const docPath = nodePath.join(os.tmpdir(), `minuta-${safeDate}-${Date.now()}.txt`);
            writeFileSync(docPath, docContent, 'utf8');

            exec(
              `bash /Users/opoclaw1/claudeclaw/scripts/tg-send-doc.sh "${docPath}" "Minuta completa"`,
              { timeout: 20000 },
              () => {}
            );

            const taskNote = actionItems.length > 0 ? ` ${actionItems.length} accion(es) pendiente(s).` : '';
            const shortMsg = `Junta lista.${taskNote}`.replace(/"/g, "'").slice(0, 200);
            exec(`bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "${shortMsg}"`, { timeout: 15000 }, () => {});
          } catch (_) {}

          return; // response already ended above

        } catch (innerErr) {
          send({ status: 'error', error: String(innerErr) });
        }

        res.end();
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/from-transcript — run Claude analysis on a pre-built transcript and save recording
  // Used by the frontend after it has already chunked and transcribed audio client-side.
  // Body: { transcript: string, durationSecs: number, meetingId?: string }
  // Returns SSE stream with { status, ... } events identical to POST /api/recordings
  app.post('/api/recordings/from-transcript', async (req: Request, res: Response) => {
    try {
      const { transcript, durationSecs = 0, meetingId, meetingType: meetingTypeFromTranscript } = req.body as {
        transcript: string; durationSecs?: number; meetingId?: string; meetingType?: string;
      };
      const meetingTypeFT = meetingTypeFromTranscript || 'general';
      if (!transcript) { res.status(400).json({ error: 'transcript required' }); return; }

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders();

      const send = (obj: object) => {
        try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {}
      };

      try {
        send({ status: 'transcribed', transcript });
        send({ status: 'processing', message: 'Analyzing with Claude...' });

        let minuta = '';
        let summary = '';
        let actionItems: string[] = [];

        const meetingTypeContextMapFT: Record<string, string> = {
          general: 'General meeting. Focus on decisions and next steps.',
          strategy: 'Strategy/Business meeting. Focus on decisions, roadmap items, and strategic direction.',
          technical: 'Technical meeting. Focus on implementation details, blockers, and architectural decisions.',
          client: 'Client/Commercial meeting. Focus on commitments made, deliverables, and next steps for the client relationship.',
          financial: 'Financial meeting. Focus on numbers, budget decisions, and financial commitments.',
        };
        const meetingTypeAgentMapFT: Record<string, string[]> = {
          general: ['Aria (Strategy)', 'Maya (Ops)'],
          strategy: ['Aria (Strategy)', 'Maya (Ops)', 'Jordan (Finance)'],
          technical: ['Marcus (Engineering)', 'Aria (Strategy)'],
          client: ['Sofia (Content)', 'Maya (Ops)', 'Aria (Strategy)'],
          financial: ['Jordan (Finance)', 'Aria (Strategy)', 'Maya (Ops)'],
        };
        const ftMeetingTypeContext = meetingTypeContextMapFT[meetingTypeFT] || meetingTypeContextMapFT['general'];
        const ftActiveAgentNames = (meetingTypeAgentMapFT[meetingTypeFT] || meetingTypeAgentMapFT['general']).join(', ');

        const notesPrompt = `IMPORTANT: Respond entirely in the same language as the transcript. If the transcript is in Spanish, respond in Spanish. If in English, respond in English. If mixed, use the dominant language. Never default to English.

Analyze this meeting transcript and produce structured meeting documentation. Do not use any tools — just reply with text in the exact format below.

Meeting Type: ${meetingTypeFT}
Context: ${ftMeetingTypeContext}
Active Agents: ${ftActiveAgentNames}

Transcript:
${transcript.slice(0, 8000)}

Respond in this exact format:
MEETING_NOTES:
[structured notes here with sections: Decisions, Action Items, Key Points]

SUMMARY:
[2-3 sentence summary]

ACTION_ITEMS:
["item 1", "item 2", ...]`;

        try {
          const notesResult = await runAgent(notesPrompt, undefined, () => {});
          const rawText = notesResult.text || '';
          const notesMatch = rawText.match(/MEETING_NOTES:\s*([\s\S]*?)(?=\nSUMMARY:|$)/);
          const summaryMatch = rawText.match(/SUMMARY:\s*([\s\S]*?)(?=\nACTION_ITEMS:|$)/);
          const actionMatch = rawText.match(/ACTION_ITEMS:\s*([\s\S]*?)$/);
          minuta = notesMatch?.[1]?.trim() || rawText;
          summary = summaryMatch?.[1]?.trim() || '';
          try { actionItems = JSON.parse(actionMatch?.[1]?.trim() || '[]') as string[]; } catch (_) {}
        } catch (aiErr) {
          logger.error({ err: aiErr }, 'recordings from-transcript: runAgent failed');
        }

        if (!minuta && transcript) { minuta = transcript; summary = transcript.slice(0, 200); }

        send({ status: 'minuta', minuta });

        const recResult = db.prepare(`
          INSERT INTO recordings (meeting_id, transcript, minuta, summary, action_items, duration_secs, meeting_type, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(meetingId || null, transcript, minuta, summary, JSON.stringify(actionItems), durationSecs, meetingTypeFT);

        if (meetingId) {
          db.prepare(`UPDATE agent_meetings SET transcript = ?, notes = ?, summary = ?, status = 'ended', end_time = datetime('now') WHERE id = ?`)
            .run(transcript, minuta, summary, meetingId);
          if (minuta) {
            db.prepare(`INSERT INTO meeting_live_notes (meeting_id, agent_id, content, created_at) VALUES (?, 'maya-chen', ?, datetime('now'))`)
              .run(meetingId, minuta);
          }
        }

        if (actionItems.length > 0) {
          for (const item of actionItems.slice(0, 10)) {
            const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            try {
              db.prepare(`INSERT INTO agent_tasks (id, title, assignee_id, assignee_name, department, priority, status, created_at, updated_at) VALUES (?, ?, 'maya-chen', 'Maya', 'operations', 'medium', 'pending', datetime('now'), datetime('now'))`)
                .run(taskId, item);
            } catch (_) {}
          }
        }

        const brainTitle = `Meeting Notes — ${new Date().toLocaleDateString('es-MX', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        const brainContent = `# ${brainTitle}\n\n## Transcript\n${transcript}\n\n## Notes\n${minuta}\n\n## Summary\n${summary}`;
        try {
          db.prepare(`INSERT INTO brain_vault (title, content, type, agent_id, agent_name, department, tags, folder_path, created_at, updated_at) VALUES (?, ?, 'document', 'maya-chen', 'Maya', 'operations', 'meeting,recording', 'Meetings', datetime('now'), datetime('now'))`)
            .run(brainTitle, brainContent);
        } catch (_) {}

        if (meetingId && minuta) {
          const agentNotes = [
            { agent_id: 'maya-chen', agent_name: 'Maya', msg: `Minuta lista. ${summary || 'Reunión transcrita y analizada.'}` },
            { agent_id: 'marcus-reyes', agent_name: 'Marcus', msg: actionItems.length > 0 ? `Detecté ${actionItems.length} acción(es) pendiente(s). Ya las creé como tareas.` : 'Sin tareas de acción detectadas en esta reunión.' },
          ];
          for (const n of agentNotes) {
            try {
              db.prepare(`INSERT INTO meeting_messages (meeting_id, agent_id, agent_name, content, message_type, created_at) VALUES (?, ?, ?, ?, 'answer', datetime('now'))`)
                .run(meetingId, n.agent_id, n.agent_name, n.msg);
            } catch (_) {}
          }
        }

        send({ status: 'done', recordingId: recResult.lastInsertRowid });
        res.end();

        try {
          const { exec } = await import('child_process');
          const taskNote = actionItems.length > 0 ? ` ${actionItems.length} accion(es) pendiente(s).` : '';
          const shortMsg = `Junta lista.${taskNote}`.replace(/"/g, "'").slice(0, 200);
          exec(`bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "${shortMsg}"`, { timeout: 15000 }, () => {});
        } catch (_) {}

      } catch (innerErr) {
        send({ status: 'error', error: String(innerErr) });
        res.end();
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/recordings/transcribe-chunk — transcribe a single audio chunk via Whisper
  // Used by the frontend when splitting large recordings into multiple sub-25MB uploads.
  // Returns { transcript: string } on success.
  app.post('/api/recordings/transcribe-chunk', async (req: Request, res: Response) => {
    try {
      const multerLib = (await import('multer')).default;
      const upload = multerLib({ storage: multerLib.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
      upload.single('audio')(req, res, async (err) => {
        if (err) { res.status(400).json({ error: String(err) }); return; }
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) { res.status(400).json({ error: 'No audio file' }); return; }

        const openaiKey = process.env['OPENAI_API_KEY'] || '';
        if (!openaiKey) { res.status(500).json({ error: 'OPENAI_API_KEY not configured' }); return; }

        const ext = file.mimetype?.includes('mp4') ? 'mp4' : file.mimetype?.includes('ogg') ? 'ogg' : file.mimetype?.includes('wav') ? 'wav' : 'webm';
        const lang = (req.body['lang'] as string) || 'es';

        const FormDataNode = (await import('form-data')).default;
        const fd = new FormDataNode();
        fd.append('file', file.buffer, { filename: `chunk.${ext}`, contentType: `audio/${ext}` });
        fd.append('model', 'whisper-1');
        fd.append('language', lang);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
        try {
          const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiKey}`, ...fd.getHeaders() },
            body: fd.getBuffer(),
            signal: controller.signal,
          });
          if (!r.ok) {
            res.status(502).json({ error: `Whisper error ${r.status}: ${await r.text()}` });
            return;
          }
          const data = await r.json() as { text?: string };
          res.json({ transcript: data.text?.trim() || '' });
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // PATCH /api/meetings/:id — update meeting fields
  app.patch('/api/meetings/:id', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { status, notes, summary, transcript, is_recording } = req.body as {
        status?: string; notes?: string; summary?: string; transcript?: string; is_recording?: boolean;
      };

      const setClauses: string[] = [];
      const values: (string | number | null)[] = [];

      if (status !== undefined) { setClauses.push('status = ?'); values.push(status); }
      if (notes !== undefined) { setClauses.push('notes = ?'); values.push(notes); }
      if (summary !== undefined) { setClauses.push('summary = ?'); values.push(summary); }
      if (transcript !== undefined) { setClauses.push('transcript = ?'); values.push(transcript); }
      if (is_recording !== undefined) { setClauses.push('is_recording = ?'); values.push(is_recording ? 1 : 0); }

      if (setClauses.length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }

      values.push(id);
      const stmt = db.prepare(`UPDATE agent_meetings SET ${setClauses.join(', ')} WHERE id = ?`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (stmt as any).run(...values) as { changes: number };
      if (result.changes === 0) {
        res.status(404).json({ error: 'Meeting not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── CREATE CALENDAR EVENT (used by google-calendar skill) ────────
  // POST /api/calendar/create  { title, date (YYYY-MM-DD), time (HH:MM), duration_min?, description? }
  app.post('/api/calendar/create', async (req: Request, res: Response) => {
    try {
      const { title, date, time, duration_min, description: evDesc } = req.body as {
        title: string; date: string; time?: string; duration_min?: number; description?: string;
      };
      if (!title || !date) { res.status(400).json({ error: 'title and date are required' }); return; }

      // Build local datetime strings (no 'Z' — timezone is passed separately to Google)
      const timeStr = time ?? '09:00';
      const startLocal = `${date}T${timeStr}:00`;
      const durationMs = (duration_min ?? 60) * 60000;
      // Compute end time by parsing as UTC-offset Monterrey time (-06:00)
      const startMs = new Date(`${date}T${timeStr}:00-06:00`).getTime();
      const endLocal = new Date(startMs + durationMs).toLocaleString('sv-SE', { timeZone: 'America/Monterrey' }).replace(' ', 'T');

      const freshToken = await getFreshGoogleToken();
      let googleEventId: string | null = null;

      if (freshToken) {
        const gcalRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: title,
            description: evDesc ?? '',
            start: { dateTime: startLocal, timeZone: 'America/Monterrey' },
            end:   { dateTime: endLocal,   timeZone: 'America/Monterrey' },
          }),
        });
        if (gcalRes.ok) {
          const gcalEvent = await gcalRes.json() as { id: string };
          googleEventId = gcalEvent.id;
        } else {
          const err = await gcalRes.json() as { error?: { message: string } };
          logger.warn({ status: gcalRes.status, err }, 'Google Calendar create failed');
        }
      }

      // Always save locally too
      db.prepare(
        `INSERT OR IGNORE INTO calendar_events (id, title, description, start_time, end_time, type, source, external_id)
         VALUES (?, ?, ?, ?, ?, 'meeting', 'thorn', ?)`
      ).run(`event-${Date.now()}`, title, evDesc ?? '', startLocal, endLocal, googleEventId);

      if (googleEventId) {
        res.json({ ok: true, in_google: true, message: `"${title}" agendado el ${date} a las ${time ?? '09:00'} en Google Calendar.` });
      } else {
        res.json({ ok: true, in_google: false, message: `"${title}" guardado localmente. Google Calendar no disponible — reconecta en el dashboard.` });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── CALENDAR EVENTS ───────────────────────────────────────────────
  app.get('/api/calendar-events', (req: Request, res: Response) => {
    try {
      const start = req.query['start'] as string | undefined;
      const end = req.query['end'] as string | undefined;
      let rows;
      if (start && end) {
        rows = db.prepare(`SELECT * FROM calendar_events WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC`).all(start, end);
      } else {
        rows = db.prepare(`SELECT * FROM calendar_events ORDER BY start_time ASC LIMIT 200`).all();
      }
      // Parse metadata JSON
      const parsed = (rows as any[]).map((r: any) => ({
        ...r,
        all_day: Boolean(r.all_day),
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
      }));
      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/calendar-events/sync', (req: Request, res: Response) => {
    try {
      const { events, start, end } = req.body as { events: any[]; start: string; end: string };
      if (!Array.isArray(events)) { res.status(400).json({ error: 'events must be array' }); return; }

      // Check Google Calendar OAuth token expiry
      try {
        const oauthRow = db.prepare(`SELECT token_expiry FROM oauth_tokens WHERE provider = 'google'`).get() as { token_expiry: string | null } | undefined;
        if (oauthRow?.token_expiry) {
          const expiresAt = new Date(oauthRow.token_expiry).getTime();
          const in24h = Date.now() + 24 * 60 * 60 * 1000;
          if (expiresAt < in24h) {
            db.prepare(`
              INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
              VALUES ('thorn', 'Thorn', '🌵', 'Google Calendar OAuth token expiring in < 24 hours - re-auth needed', 'warning', 'executive', datetime('now'))
            `).run();
          }
        }
      } catch { /* never block sync over a logging failure */ }

      // Delete existing events in this range (replace strategy)
      if (start && end) {
        db.prepare(`DELETE FROM calendar_events WHERE start_time >= ? AND start_time <= ?`).run(start, end);
      }

      const upsert = db.prepare(`
        INSERT OR REPLACE INTO calendar_events
          (id, title, description, start_time, end_time, type, all_day, source, external_id, external_url, agent_id, metadata, synced_at)
        VALUES
          (@id, @title, @description, @start_time, @end_time, @type, @all_day, @source, @external_id, @external_url, @agent_id, @metadata, datetime('now'))
      `);

      const insertMany = db.transaction((...args: unknown[]) => {
        for (const e of args[0] as any[]) {
          upsert.run({
            id: e.external_id ?? `gcal-${Date.now()}-${Math.random()}`,
            title: e.title ?? 'Sin título',
            description: e.description ?? null,
            start_time: e.start_time,
            end_time: e.end_time,
            type: e.type ?? 'meeting',
            all_day: e.all_day ? 1 : 0,
            source: e.source ?? 'google',
            external_id: e.external_id ?? null,
            external_url: e.external_url ?? null,
            agent_id: e.agent_id ?? null,
            metadata: e.metadata ? JSON.stringify(e.metadata) : null,
          });
        }
      });
      insertMany(events);

      cacheInvalidate('calendar');
      res.json({ ok: true, synced: events.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE CALENDAR EVENT ─────────────────────────────────────────
  // DELETE /api/calendar/events/:id  — deletes from Google Calendar + local DB
  app.delete('/api/calendar/events/:id', async (req: Request, res: Response) => {
    try {
      const eventId = req.params['id'] as string;
      if (!eventId) { res.status(400).json({ error: 'eventId required' }); return; }

      // Look up external_id (Google Calendar event id) from local DB
      const row = db.prepare(`SELECT external_id FROM calendar_events WHERE id = ?`).get(eventId) as { external_id: string | null } | undefined;
      const googleEventId = row?.external_id ?? null;

      // Delete from Google Calendar if we have a token + external id
      if (googleEventId) {
        const freshToken = await getFreshGoogleToken();
        if (freshToken) {
          const gcalRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`,
            { method: 'DELETE', headers: { 'Authorization': `Bearer ${freshToken}` } }
          );
          if (!gcalRes.ok && gcalRes.status !== 404 && gcalRes.status !== 410) {
            const errBody = await gcalRes.text();
            logger.warn({ status: gcalRes.status, errBody }, 'Google Calendar delete non-fatal error');
          }
        }
      }

      // Delete from local DB regardless
      db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(eventId);
      cacheInvalidate('calendar');

      res.json({ ok: true, deleted: eventId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── UPDATE CALENDAR EVENT ─────────────────────────────────────────
  // PATCH /api/calendar/events/:id  { title?, start_time?, end_time?, description? }
  app.patch('/api/calendar/events/:id', async (req: Request, res: Response) => {
    try {
      const eventId = req.params['id'] as string;
      if (!eventId) { res.status(400).json({ error: 'eventId required' }); return; }

      const { title, start_time, end_time, description: evDesc } = req.body as {
        title?: string; start_time?: string; end_time?: string; description?: string;
      };

      // Fetch current event from local DB
      const current = db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(eventId) as {
        id: string; title: string; description: string | null; start_time: string; end_time: string;
        external_id: string | null; metadata: string | null;
      } | undefined;

      if (!current) { res.status(404).json({ error: 'Event not found' }); return; }

      const newTitle = title ?? current.title;
      const newStart = start_time ?? current.start_time;
      const newEnd = end_time ?? current.end_time;
      const newDesc = evDesc ?? current.description ?? '';

      // Update in Google Calendar if we have token + external id
      if (current.external_id) {
        const freshToken = await getFreshGoogleToken();
        if (freshToken) {
          const patchBody: Record<string, unknown> = {
            summary: newTitle,
            description: newDesc,
            start: { dateTime: newStart, timeZone: 'America/Monterrey' },
            end: { dateTime: newEnd, timeZone: 'America/Monterrey' },
          };
          const gcalRes = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(current.external_id)}`,
            {
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(patchBody),
            }
          );
          if (!gcalRes.ok) {
            const errBody = await gcalRes.text();
            logger.warn({ status: gcalRes.status, errBody }, 'Google Calendar patch failed');
          }
        }
      }

      // Update local DB
      db.prepare(`
        UPDATE calendar_events SET title = ?, start_time = ?, end_time = ?, description = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(newTitle, newStart, newEnd, newDesc, eventId);

      cacheInvalidate('calendar');
      const updated = db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(eventId);
      res.json({ ok: true, event: updated });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── CREATE EVENT FROM NATURAL LANGUAGE ───────────────────────────
  // POST /api/calendar/create-from-text  { text: string }
  // Uses simple regex + date parsing to extract event details without needing Anthropic API key.
  app.post('/api/calendar/create-from-text', async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text: string };
      if (!text) { res.status(400).json({ error: 'text is required' }); return; }

      // Use the runAgent function with the Claude SDK (OAuth, no API key)
      // to parse natural language into structured event data.
      const parsePrompt = `You are a calendar assistant. Parse this natural language event request and return ONLY a JSON object (no markdown, no explanation):
"${text}"

Return exactly this JSON shape:
{
  "title": "event title",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "duration_min": 60,
  "description": "",
  "attendees": ["email1@example.com", "email2@example.com"]
}

Today is ${new Date().toISOString().split('T')[0]}. Use 24h time. If no date specified, use today. If no time specified, use 09:00. If no duration, default 60 minutes. Extract ALL email addresses mentioned in the request and put them in the attendees array. If no emails are mentioned, return an empty array for attendees.`;

      let parsedEvent: { title: string; date: string; time: string; duration_min: number; description?: string; attendees?: string[] } | null = null;

      try {
        const agentResult = await runAgent(parsePrompt, undefined, () => {});

        if (agentResult.text) {
          // Extract JSON from response (strip any markdown fences if present)
          const jsonMatch = agentResult.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedEvent = JSON.parse(jsonMatch[0]);
          }
        }
      } catch (parseErr) {
        logger.warn({ parseErr }, 'Claude parse failed, falling back to regex');
      }

      // Fallback: regex-based parsing if Claude fails
      if (!parsedEvent) {
        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

        // Extract time like "at 3pm", "at 15:00", "a las 3pm"
        const timeMatch = text.match(/(?:at|a las?|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        let hour = 9;
        let minute = 0;
        if (timeMatch) {
          hour = parseInt(timeMatch[1]);
          minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
          const meridiem = timeMatch[3]?.toLowerCase();
          if (meridiem === 'pm' && hour < 12) hour += 12;
          if (meridiem === 'am' && hour === 12) hour = 0;
        }

        // Extract date references
        let date = today;
        if (/tomorrow|ma[nñ]ana/i.test(text)) date = tomorrow;
        else if (/monday|lunes/i.test(text)) { /* find next monday */ }

        // Duration
        const durMatch = text.match(/(\d+)\s*(hour|hora|hr|min|minute)/i);
        const duration_min = durMatch
          ? (/hour|hora|hr/i.test(durMatch[2]) ? parseInt(durMatch[1]) * 60 : parseInt(durMatch[1]))
          : 60;

        // Title: strip time/date references
        const title = text
          .replace(/(?:at|a las?|@)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, '')
          .replace(/tomorrow|ma[nñ]ana|today|hoy/gi, '')
          .replace(/for\s+\d+\s+(?:hour|hora|hr|min|minute)s?/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^(Schedule|Create|Add|Agendar|Crear|Agregar)\s+/i, '')
          || 'New Event';

        // Extract email addresses from text
        const emailMatches = text.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi) ?? [];

        parsedEvent = {
          title: title.charAt(0).toUpperCase() + title.slice(1),
          date,
          time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
          duration_min,
          description: '',
          attendees: emailMatches,
        };
      }

      if (!parsedEvent) {
        res.status(422).json({ error: 'Could not parse event from text. Please be more specific.' });
        return;
      }

      // Now create the event using the existing /api/calendar/create logic
      const { title, date, time, duration_min, description: evDesc, attendees: evAttendees } = parsedEvent;
      const timeStr = time ?? '09:00';
      const startLocal = `${date}T${timeStr}:00`;
      const durationMs = (duration_min ?? 60) * 60000;
      const startMs = new Date(`${date}T${timeStr}:00-06:00`).getTime();
      const endLocal = new Date(startMs + durationMs).toLocaleString('sv-SE', { timeZone: 'America/Monterrey' }).replace(' ', 'T');

      // Build attendees list from parsed emails
      const attendeeEmails = (evAttendees ?? []).filter(Boolean);
      const attendeesPayload = attendeeEmails.map((email) => ({ email }));

      const freshToken = await getFreshGoogleToken();
      let googleEventId: string | null = null;

      if (freshToken) {
        const gcalBody: Record<string, unknown> = {
          summary: title,
          description: evDesc ?? '',
          start: { dateTime: startLocal, timeZone: 'America/Monterrey' },
          end:   { dateTime: endLocal,   timeZone: 'America/Monterrey' },
        };
        if (attendeesPayload.length > 0) {
          gcalBody.attendees = attendeesPayload;
          // sendUpdates: 'all' triggers actual email invites to attendees
          gcalBody.sendUpdates = 'all';
        }
        const gcalRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(gcalBody),
        });
        if (gcalRes.ok) {
          const gcalEvent = await gcalRes.json() as { id: string };
          googleEventId = gcalEvent.id;
        } else {
          const err = await gcalRes.json() as { error?: { message: string } };
          logger.warn({ status: gcalRes.status, err }, 'Google Calendar create-from-text failed');
        }
      }

      const localId = `event-${Date.now()}`;
      const eventMetadata = JSON.stringify({
        attendees: attendeeEmails,
        attendees_count: attendeeEmails.length,
      });
      db.prepare(
        `INSERT OR IGNORE INTO calendar_events (id, title, description, start_time, end_time, type, source, external_id, metadata)
         VALUES (?, ?, ?, ?, ?, 'meeting', 'thorn', ?, ?)`
      ).run(localId, title, evDesc ?? '', startLocal, endLocal, googleEventId, eventMetadata);

      cacheInvalidate('calendar');

      const attendeeSuffix = attendeeEmails.length > 0
        ? ` Invites sent to: ${attendeeEmails.join(', ')}.`
        : '';

      res.json({
        ok: true,
        in_google: !!googleEventId,
        event: { id: localId, title, date, time: timeStr, duration_min, start_time: startLocal, end_time: endLocal, attendees: attendeeEmails },
        message: googleEventId
          ? `"${title}" scheduled on ${date} at ${timeStr} in Google Calendar.${attendeeSuffix}`
          : `"${title}" saved locally. Reconnect Google Calendar to sync.`,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── HANDOFFS (stub) ───────────────────────────────────────────────
  app.get('/api/handoffs', (_req: Request, res: Response) => {
    res.json([]);
  });

  // ── POST /api/meetings ────────────────────────────────────────────
  app.post('/api/meetings', (req: Request, res: Response) => {
    try {
      const { topic, is_recording, gonzalo_present } = req.body as { topic?: string; is_recording?: boolean; gonzalo_present?: boolean };
      if (!topic) {
        res.status(400).json({ error: 'topic is required' });
        return;
      }
      const id = `meeting-${Date.now()}`;
      db.prepare(`
        INSERT INTO agent_meetings (id, topic, status, is_recording, gonzalo_present, start_time)
        VALUES (?, ?, 'active', ?, ?, datetime('now'))
      `).run(id, topic, is_recording ? 1 : 0, gonzalo_present ? 1 : 0);

      // Auto-add Maya (notes) and Marcus (tasks) as participants
      const defaultParticipants = [
        { agent_id: 'maya-chen', agent_name: 'Maya', role: 'note_taker' },
        { agent_id: 'marcus-reyes', agent_name: 'Marcus', role: 'participant' },
      ];
      for (const p of defaultParticipants) {
        try {
          db.prepare(`
            INSERT INTO meeting_participants (meeting_id, agent_id, agent_name, role)
            VALUES (?, ?, ?, ?)
          `).run(id, p.agent_id, p.agent_name, p.role);
        } catch (_) {}
      }

      // Add an initial live note from Maya
      db.prepare(`
        INSERT INTO meeting_live_notes (meeting_id, agent_id, content, created_at)
        VALUES (?, 'maya-chen', 'Joining meeting. Ready to take notes.', datetime('now'))
      `).run(id);

      const created = db.prepare(`SELECT * FROM agent_meetings WHERE id = ?`).get(id);
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── MEETINGS (extended) ───────────────────────────────────────────
  app.get('/api/meetings/:id/messages', (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query['limit']) || 200, 500);
      const id = req.params.id as string;
      // Merge meeting_messages + meeting_live_notes into one unified feed
      const msgs = db.prepare(
        `SELECT id, meeting_id, agent_id, agent_name,
                content as message, message_type, created_at, 'message' as source
         FROM meeting_messages WHERE meeting_id = ?
         UNION ALL
         SELECT id, meeting_id, agent_id, agent_id as agent_name,
                content as message, 'note' as message_type, created_at, 'note' as source
         FROM meeting_live_notes WHERE meeting_id = ?
         ORDER BY created_at LIMIT ?`
      ).all(id, id, limit);
      res.json(msgs);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/meetings/:id/close', (req: Request, res: Response) => {
    try {
      const result = db.prepare(`UPDATE agent_meetings SET status = 'ended', end_time = datetime('now') WHERE id = ?`).run(req.params.id as string);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Meeting not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/agent-metrics ────────────────────────────────────────
  // Optimized: 4 aggregate queries total (was 4 × N per agent). Cached 30s.
  app.get('/api/agent-metrics', (_req: Request, res: Response) => {
    try {
      const cached = cacheGet('agent-metrics');
      if (cached) { res.json(cached); return; }

      const agents = db.prepare(`SELECT id, name, department FROM agents`).all() as Array<{ id: string; name: string; department: string }>;

      // 1. Task stats aggregated per agent
      const taskRows = db.prepare(`
        SELECT assignee_id,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as active
        FROM agent_tasks
        GROUP BY assignee_id
      `).all() as Array<{ assignee_id: string; total: number; done: number; active: number }>;
      const taskMap = new Map(taskRows.map((r) => [r.assignee_id, r]));

      // 2. Total activity per agent
      const activityRows = db.prepare(`
        SELECT agent_id, COUNT(*) as cnt FROM agent_activity GROUP BY agent_id
      `).all() as Array<{ agent_id: string; cnt: number }>;
      const activityMap = new Map(activityRows.map((r) => [r.agent_id, r.cnt]));

      // 3. Activity in last 7 days per agent
      const weekRows = db.prepare(`
        SELECT agent_id, COUNT(*) as cnt FROM agent_activity
        WHERE created_at >= datetime('now', '-7 days')
        GROUP BY agent_id
      `).all() as Array<{ agent_id: string; cnt: number }>;
      const weekMap = new Map(weekRows.map((r) => [r.agent_id, r.cnt]));

      // 4. LLM costs this month per agent
      const llmRows = db.prepare(`
        SELECT agent_id,
          COALESCE(SUM(cost_usd), 0) as cost,
          COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
          COUNT(*) as calls
        FROM llm_costs
        WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
        GROUP BY agent_id
      `).all() as Array<{ agent_id: string; cost: number; tokens: number; calls: number }>;
      const llmMap = new Map(llmRows.map((r) => [r.agent_id, r]));

      const metrics = agents.map((agent) => {
        const taskStats  = taskMap.get(agent.id)    ?? { total: 0, done: 0, active: 0 };
        const llmStats   = llmMap.get(agent.id)     ?? { cost: 0, tokens: 0, calls: 0 };
        const actTotal   = activityMap.get(agent.id) ?? 0;
        const actWeek    = weekMap.get(agent.id)     ?? 0;

        const completionRate = taskStats.total > 0
          ? Math.round((taskStats.done / taskStats.total) * 100)
          : 0;

        return {
          agent_id: agent.id,
          agent_name: agent.name,
          department: agent.department,
          tasks_total: taskStats.total ?? 0,
          tasks_done: taskStats.done ?? 0,
          tasks_active: taskStats.active ?? 0,
          completion_rate: completionRate,
          activity_total: actTotal,
          activity_this_week: actWeek,
          llm_cost_month: Math.round((llmStats.cost ?? 0) * 10000) / 10000,
          llm_tokens_month: llmStats.tokens ?? 0,
          llm_calls_month: llmStats.calls ?? 0,
          kpis: [
            { label: 'Task Completion', value: completionRate, target: 80 },
            { label: 'Activity (7d)', value: actWeek, target: 10 },
            { label: 'LLM Cost ($)', value: Math.round((llmStats.cost ?? 0) * 100) / 100, target: 5 },
          ],
        };
      });

      cacheSet('agent-metrics', metrics, 30_000); // 30s TTL
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/scheduled-tasks ──────────────────────────────────────
  // Reads from the opoclaw main DB (scheduled_tasks table)
  app.get('/api/scheduled-tasks', (_req: Request, res: Response) => {
    try {
      const rows = (() => {
        try {
          const data = db.prepare(
            `SELECT id, prompt, schedule, status, last_run, next_run, last_result, created_at
             FROM scheduled_tasks ORDER BY created_at DESC`
          ).all() as Array<Record<string, unknown>>;
          return data;
        } catch (_) {
          return [];
        }
      })();

      const tasks = (rows as Array<Record<string, unknown>>).map((row) => ({
        id: row['id'],
        prompt: row['prompt'],
        schedule: row['schedule'],
        status: row['status'] ?? 'active',
        last_run: row['last_run'] ? new Date(Number(row['last_run']) * 1000).toISOString() : null,
        next_run: row['next_run'] ? new Date(Number(row['next_run']) * 1000).toISOString() : null,
        last_result: row['last_result'] ?? null,
        created_at: row['created_at'] ? new Date(Number(row['created_at']) * 1000).toISOString() : null,
      }));

      res.json(tasks);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── PATCH /api/scheduled-tasks/:id ────────────────────────────────
  app.patch('/api/scheduled-tasks/:id', (req: Request, res: Response) => {
    try {
      const { status } = req.body as { status?: string };
      if (!status || !['active', 'paused'].includes(status)) {
        res.status(400).json({ error: 'status must be active or paused' });
        return;
      }
      const result = db.prepare(
        `UPDATE scheduled_tasks SET status = ? WHERE id = ?`
      ).run(status, req.params.id as string);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json({ ok: true, id: req.params.id, status });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE /api/scheduled-tasks/:id ───────────────────────────────
  app.delete('/api/scheduled-tasks/:id', (req: Request, res: Response) => {
    try {
      const result = db.prepare(
        `DELETE FROM scheduled_tasks WHERE id = ?`
      ).run(req.params.id as string);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/sessions ─────────────────────────────────────────────
  // Returns session + token_usage stats from the main opoclaw DB
  app.get('/api/sessions', (_req: Request, res: Response) => {
    try {
      const cached = cacheGet('sessions');
      if (cached) { res.json(cached); return; }

      const result = (() => {
        try {
          const sessions = db.prepare(
            `SELECT s.chat_id, s.session_id, s.updated_at,
                    COUNT(tu.id) as turns,
                    MAX(tu.cache_read) as context_tokens,
                    COALESCE(SUM(tu.output_tokens), 0) as total_output_tokens,
                    COALESCE(SUM(tu.input_tokens), 0) as total_input_tokens,
                    COALESCE(SUM(tu.cost_usd), 0) as total_cost_usd,
                    COALESCE(SUM(tu.did_compact), 0) as compactions
             FROM sessions s
             LEFT JOIN token_usage tu ON tu.session_id = s.session_id
             GROUP BY s.chat_id, s.session_id
             ORDER BY s.updated_at DESC`
          ).all() as Array<Record<string, unknown>>;

          const tokenStats = db.prepare(
            `SELECT
               COUNT(*) as total_turns,
               COALESCE(SUM(cost_usd), 0) as total_cost,
               COALESCE(SUM(output_tokens), 0) as total_output,
               COALESCE(SUM(input_tokens), 0) as total_input,
               COALESCE(MAX(cache_read), 0) as peak_context
             FROM token_usage`
          ).get() as Record<string, number>;

          const dailyCost = db.prepare(
            `SELECT date(datetime(created_at, 'unixepoch')) as day,
                    ROUND(SUM(cost_usd), 4) as cost,
                    COUNT(*) as turns
             FROM token_usage
             WHERE created_at >= strftime('%s', date('now', '-30 days'))
             GROUP BY day ORDER BY day`
          ).all();

          return { sessions, tokenStats, dailyCost };
        } catch (_) {
          return { sessions: [], tokenStats: {}, dailyCost: [] };
        }
      })();

      cacheSet('sessions', result, 30_000); // 30s TTL — token usage only changes on new turns
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/scheduled-tasks ─────────────────────────────────────
  // Creates a new scheduled task in the main opoclaw DB
  app.post('/api/scheduled-tasks', (req: Request, res: Response) => {
    try {
      const { prompt, schedule } = req.body as { prompt?: string; schedule?: string };
      if (!prompt || !schedule) {
        res.status(400).json({ error: 'prompt and schedule are required' });
        return;
      }
      // Validate cron expression: each field must be *, a number, a range (x-y), a step (*/x), or a list (x,y,z)
      const cronFieldRe = /^(\*|\d+(-\d+)?|\*\/\d+|\d+(,\d+)+)$/;
      const cronParts = schedule.trim().split(/\s+/);
      if ((cronParts.length !== 5 && cronParts.length !== 6) || !cronParts.every(p => cronFieldRe.test(p))) {
        res.status(400).json({ error: 'Invalid cron expression' });
        return;
      }
      // Generate a short random id matching the pattern used by schedule-cli
      const id = Math.random().toString(36).slice(2, 10);
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(id, prompt, schedule, now + 3600, now);
      const created = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as Record<string, unknown>;
      res.status(201).json({
        id: created['id'],
        prompt: created['prompt'],
        schedule: created['schedule'],
        status: created['status'] ?? 'active',
        last_run: null,
        next_run: created['next_run'] ? new Date(Number(created['next_run']) * 1000).toISOString() : null,
        last_result: null,
        created_at: created['created_at'] ? new Date(Number(created['created_at']) * 1000).toISOString() : null,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/memories ─────────────────────────────────────────────
  // Returns semantic/episodic memories from the main opoclaw DB
  app.get('/api/memories', (req: Request, res: Response) => {
    try {
      const sector = req.query['sector'] as string | undefined;
      const search = req.query['search'] as string | undefined;
      const limit  = Math.min(Number(req.query['limit']) || 50, 200);
      const offset = Math.max(Number(req.query['offset']) || 0, 0);

      const result = (() => {
        try {
          const conditions: string[] = [];
          const params: SqlBinding[] = [];
          if (sector && sector !== 'all') { conditions.push('sector = ?'); params.push(sector); }
          if (search) { conditions.push('content LIKE ?'); params.push(`%${search}%`); }

          const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
          const total = (db.prepare(`SELECT COUNT(*) as cnt FROM memories ${where}`).get(...params) as { cnt: number }).cnt;
          const rows  = db.prepare(`SELECT * FROM memories ${where} ORDER BY salience DESC, accessed_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, unknown>>;

          // bySector doesn't depend on the current filter — cache it independently
          let bySector = cacheGet('memories-by-sector') as unknown[] | undefined;
          if (!bySector) {
            bySector = db.prepare(`SELECT sector, COUNT(*) as cnt FROM memories GROUP BY sector ORDER BY cnt DESC`).all();
            cacheSet('memories-by-sector', bySector, 60_000); // 60s TTL
          }

          return {
            total,
            offset,
            limit,
            rows: rows.map((r) => ({
              ...r,
              created_at: r['created_at'] ? new Date(Number(r['created_at']) * 1000).toISOString() : null,
              accessed_at: r['accessed_at'] ? new Date(Number(r['accessed_at']) * 1000).toISOString() : null,
            })),
            bySector,
          };
        } catch (_) {
          return { total: 0, offset: 0, limit, rows: [], bySector: [] };
        }
      })();

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE /api/memories/:id ──────────────────────────────────────
  app.delete('/api/memories/:id', (req: Request, res: Response) => {
    try {
      const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(req.params.id as string);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Memory not found' });
        return;
      }
      cacheInvalidate('memories-by-sector'); // sector counts changed
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/conversation-log ─────────────────────────────────────
  app.get('/api/conversation-log', (req: Request, res: Response) => {
    try {
      const sessionId = req.query['sessionId'] as string | undefined;
      const limit = Math.min(Number(req.query['limit']) || 50, 200);

      const result = (() => {
        try {
          let rows;
          if (sessionId) {
            rows = db.prepare(
              `SELECT * FROM conversation_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
            ).all(sessionId, limit);
          } else {
            rows = db.prepare(
              `SELECT * FROM conversation_log ORDER BY created_at DESC LIMIT ?`
            ).all(limit);
          }
          return rows;
        } catch (_) {
          return [];
        }
      })();

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GOOGLE OAUTH SERVER-SIDE (with refresh token) ─────────────────
  // Starts the OAuth flow requesting offline access (refresh token)
  app.get('/api/google-oauth/start', (_req: Request, res: Response) => {
    const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
    const redirectUri = `http://localhost:${PORT}/api/google-oauth/callback`;
    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' ');
    const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&access_type=offline` +
      `&prompt=consent`;
    res.redirect(url);
  });

  // Handles the OAuth callback and saves refresh token permanently
  app.get('/api/google-oauth/callback', async (req: Request, res: Response) => {
    const code = req.query['code'] as string;
    if (!code) { res.status(400).send('Missing code'); return; }

    try {
      const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
      const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] || '';
      const redirectUri = `http://localhost:${PORT}/api/google-oauth/callback`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      });
      const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

      if (tokens.error || !tokens.access_token) {
        res.status(400).send(`OAuth error: ${tokens.error}`);
        return;
      }

      const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

      // Get email
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const user = await userRes.json() as { email?: string };

      db.prepare(`
        INSERT INTO oauth_tokens (provider, access_token, refresh_token, token_expiry, account_email, updated_at)
        VALUES ('google', ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(provider) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
          token_expiry = excluded.token_expiry,
          account_email = excluded.account_email,
          updated_at = datetime('now')
      `).run(tokens.access_token, tokens.refresh_token || null, expiry, user.email || '');

      res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>Google Calendar conectado</h2>
        <p>Cuenta: <strong>${user.email}</strong></p>
        <p>Refresh token guardado permanentemente. Ya puedes cerrar esta ventana.</p>
      </body></html>`);
    } catch (err) {
      res.status(500).send(`Error: ${String(err)}`);
    }
  });

  // ── GMAIL SERVER-SIDE OAUTH (with refresh token, for agents) ──────────────
  app.get('/api/gmail-oauth/start', (_req: Request, res: Response) => {
    const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
    const redirectUri = `http://localhost:${PORT}/api/gmail-oauth/callback`;
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' ');
    const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&access_type=offline` +
      `&prompt=consent`;
    res.redirect(url);
  });

  app.get('/api/gmail-oauth/callback', async (req: Request, res: Response) => {
    const code = req.query['code'] as string;
    if (!code) { res.status(400).send('Missing code'); return; }
    try {
      const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
      const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] || '';
      const redirectUri = `http://localhost:${PORT}/api/gmail-oauth/callback`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      });
      const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
      if (tokens.error || !tokens.access_token) { res.status(400).send(`OAuth error: ${tokens.error}`); return; }

      const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const user = await userRes.json() as { email?: string };

      db.prepare(`
        INSERT INTO oauth_tokens (provider, access_token, refresh_token, token_expiry, account_email, updated_at)
        VALUES ('gmail', ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(provider) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
          token_expiry = excluded.token_expiry,
          account_email = excluded.account_email,
          updated_at = datetime('now')
      `).run(tokens.access_token, tokens.refresh_token || null, expiry, user.email || '');

      res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>Gmail conectado</h2>
        <p>Cuenta: <strong>${user.email}</strong></p>
        <p>Refresh token guardado. Los agentes ya pueden enviar correos desde esta cuenta. Puedes cerrar esta ventana.</p>
      </body></html>`);
    } catch (err) {
      res.status(500).send(`Error: ${String(err)}`);
    }
  });

  // Helper: get fresh Gmail access token using refresh token
  async function getFreshGmailToken(): Promise<string | null> {
    const row = db.prepare(`SELECT access_token, refresh_token, token_expiry FROM oauth_tokens WHERE provider = 'gmail'`).get() as { access_token: string; refresh_token: string | null; token_expiry: string } | undefined;
    if (!row) return null;

    const expiresAt = new Date(row.token_expiry).getTime();
    if (Date.now() < expiresAt - 120000) return row.access_token;

    if (!row.refresh_token) return null;

    const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
    const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] || '';
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: row.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
    });
    const data = await refreshRes.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    db.prepare(`UPDATE oauth_tokens SET access_token = ?, token_expiry = ?, updated_at = datetime('now') WHERE provider = 'gmail'`).run(data.access_token, newExpiry);
    return data.access_token;
  }

  // Agent email send endpoint — agents POST here to send from opoclaw@gmail.com
  app.post('/api/gmail/send', async (req: Request, res: Response) => {
    try {
      const { to, subject, body, replyToMessageId } = req.body as { to: string; subject: string; body: string; replyToMessageId?: string };
      if (!to || !subject || !body) { res.status(400).json({ error: 'to, subject, body required' }); return; }

      const token = await getFreshGmailToken();
      if (!token) { res.status(401).json({ error: 'Gmail not connected. Visit /api/gmail-oauth/start' }); return; }

      const result = await sendGmailMessage(token, to, subject, body, replyToMessageId);
      logger.info(`[gmail/send] Sent email to ${to} | subject: ${subject}`);
      res.json({ ok: true, messageId: result.id });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Gmail Prospect Reply Poller ────────────────────────────────────────────
  // Ensure auto_replied_at column exists (migration)
  try { db.exec(`ALTER TABLE inbox_messages ADD COLUMN auto_replied_at TEXT`); } catch { /* already exists */ }

  // Known prospect emails from outreach campaign (March 2026)
  const PROSPECT_EMAILS = new Set([
    'team@clutchgrowth.com',
    'hello@hellomediasocial.com',
    'hello@hallaron.com',
    'info@sevenatoms.com',
    'hello@helloprgroup.com',
    'hello@trendygrandad.com',
    'hello@tegra.co',
    'hello@proper.ph',
    'support@automationagency.com',
    'justin@rocktherankings.io',
    'hello@pivotmade.com',
    'hello@instrument.com',
  ]);

  // Track which gmail message IDs we've already auto-replied to (in-memory, resets on restart — DB is source of truth)
  const autoRepliedIds = new Set<string>();

  async function pollProspectReplies(): Promise<void> {
    const token = await getFreshGmailToken();
    if (!token) {
      logger.warn('[prospect-poller] No Gmail token — skipping poll');
      return;
    }

    // Search for messages from any prospect in the last 2 days (not just unread — autosync can mark read before we poll)
    const prospectQuery = [...PROSPECT_EMAILS].map(e => `from:${e}`).join(' OR ');
    const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=newer_than:2d (${encodeURIComponent(prospectQuery)})`;

    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!searchRes.ok) {
      logger.warn({ status: searchRes.status }, '[prospect-poller] Gmail search failed');
      return;
    }

    const searchData = await searchRes.json() as { messages?: Array<{ id: string; threadId: string }> };
    const messages = searchData.messages ?? [];
    if (messages.length === 0) return;

    logger.info(`[prospect-poller] Found ${messages.length} unread prospect message(s)`);

    for (const { id: gmailId } of messages) {
      if (autoRepliedIds.has(gmailId)) continue;

      // Check if we already processed this in DB
      const existing = db.prepare(`SELECT id, auto_replied_at FROM inbox_messages WHERE gmail_id = ?`).get(gmailId) as any;
      if (existing?.auto_replied_at) {
        autoRepliedIds.add(gmailId);
        continue;
      }

      // Fetch full message
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=full`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!msgRes.ok) continue;
      const msgData = await msgRes.json() as any;

      // Extract headers
      const headers: Record<string, string> = {};
      for (const h of (msgData.payload?.headers ?? [])) {
        headers[h.name.toLowerCase()] = h.value;
      }
      const fromHeader = headers['from'] ?? '';
      const fromEmail = (fromHeader.match(/<(.+?)>/) ?? [, fromHeader])[1]?.toLowerCase() ?? '';
      const subject = headers['subject'] ?? '(no subject)';
      const messageIdHeader = headers['message-id'] ?? '';

      if (!PROSPECT_EMAILS.has(fromEmail)) continue; // not a prospect

      // Extract body text
      let bodyText = '';
      const extractText = (part: any): string => {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          for (const p of part.parts) {
            const t = extractText(p);
            if (t) return t;
          }
        }
        return '';
      };
      bodyText = extractText(msgData.payload).slice(0, 1500);

      // Skip automated ticket/notification responses
      const autoKeywords = ['ticket has been logged', 'automated reply', 'auto-reply', 'out of office', 'support ticket', 'we got it', 'do not reply', 'noreply', 'no-reply'];
      if (autoKeywords.some(k => bodyText.toLowerCase().includes(k) || subject.toLowerCase().includes(k))) {
        logger.info(`[prospect-poller] Skipping automated response from ${fromEmail}`);
        autoRepliedIds.add(gmailId);
        continue;
      }

      logger.info(`[prospect-poller] Processing reply from ${fromEmail} | subject: ${subject}`);

      // Generate a contextual reply using Claude CLI
      const ownerNameMaya = process.env['OWNER_NAME'] || 'the owner';
      const replyPrompt = `You are Maya Chen, Operations Manager at OpoClaw — an AI automation agency run by ${ownerNameMaya}. You are managing the business email opoclaw@gmail.com and responding to a prospect who replied to our cold outreach.

Context: OpoClaw sent a cold email offering AI automation services (workflow automation audits, AI content at scale, custom agent builds). The prospect has replied and you need to respond professionally, warmly, and move them toward a discovery call or demo.

From: ${fromHeader}
Subject: ${subject}
Their message:
${bodyText}

Instructions:
- If they seem interested (asking for more info, pricing, availability) → propose a quick 30-minute discovery call, offer 2-3 time slots this week (Mon-Fri 10am-6pm CST), confirm OpoClaw's value prop in 1-2 sentences. If they ask about pricing or want to move forward, mention our entry package starts at $500 USD and share the payment link: https://www.paypal.com/ncp/payment/SY8FRC5YTEHEE
- If they have objections or questions → answer briefly and professionally, address the concern, re-propose the call
- If they say not interested/wrong person → thank them politely, ask if there's a better contact, keep door open
- If unclear → ask one clarifying question and express genuine interest
- Tone: professional, warm, direct. No emojis. No corporate fluff. Sign as "Gonzalo, OpoClaw"
- Length: 4-8 sentences max

Return ONLY the email body text (no subject line, no JSON, no explanation).`;

      let replyBody: string;
      try {
        replyBody = (await callClaudeCLI(replyPrompt, 60_000)).trim();
      } catch (err) {
        logger.error({ err, fromEmail }, '[prospect-poller] Failed to generate reply');
        continue;
      }

      if (!replyBody || replyBody.length < 10) continue;

      // Send the reply
      try {
        await sendGmailMessage(token, fromEmail, subject, replyBody, messageIdHeader || undefined);
        autoRepliedIds.add(gmailId);

        // Mark as read in Gmail
        await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}/modify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
        });

        // Upsert to inbox_messages with auto_replied_at
        db.prepare(`
          INSERT INTO inbox_messages (id, gmail_id, subject, sender, from_email, body_snippet, body_full, read_msg, timestamp, account_email, category, ai_draft, has_draft, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'opoclaw@gmail.com', 'awaiting_reply', ?, 0, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET read_msg=1, category='awaiting_reply', ai_draft=excluded.ai_draft, synced_at=datetime('now')
        `).run(
          gmailId, gmailId, subject, fromHeader, fromEmail,
          bodyText.slice(0, 200), bodyText,
          new Date().toISOString(), replyBody
        );

        db.prepare(`UPDATE inbox_messages SET auto_replied_at = datetime('now') WHERE gmail_id = ?`).run(gmailId);

        // Update client status in SQLite clients table: prospect → replied
        try {
          const existingClient = db.prepare('SELECT id FROM clients WHERE email = ? AND status = ?').get(fromEmail.toLowerCase(), 'prospect') as { id: string } | undefined;
          if (existingClient) {
            db.prepare(`
              UPDATE clients SET status = 'replied', pipeline_stage = 'replied',
                replied_at = datetime('now'), last_contact_at = datetime('now'),
                notes = CASE WHEN notes IS NULL THEN ? ELSE notes || ' | ' || ? END,
                updated_at = datetime('now')
              WHERE id = ?
            `).run(
              `Replied ${new Date().toLocaleDateString()} — Maya auto-responded`,
              `Replied ${new Date().toLocaleDateString()} — Maya auto-responded`,
              existingClient.id
            );
          } else {
            // Add new prospect who replied to our outreach
            db.prepare(`
              INSERT INTO clients (id, name, email, company, channel, service, status, pipeline_stage,
                assigned_agent, notes, replied_at, last_contact_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'),datetime('now'))
            `).run(
              `client-${Date.now()}`,
              fromHeader.replace(/<.+>/, '').trim() || fromEmail,
              fromEmail.toLowerCase(),
              fromEmail.split('@')[1]?.split('.')[0] ?? fromEmail,
              'ai-service',
              'inbound-reply',
              'replied',
              'replied',
              'maya-chen',
              `Replied to our outreach — ${subject}`
            );
          }
        } catch (e) {
          logger.warn({ err: e }, '[prospect-poller] Failed to update client status in SQLite');
        }

        // Log to activity feed
        db.prepare(`
          INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
          VALUES ('maya-chen', 'Maya Chen', '🎯', ?, 'success', 'operations', datetime('now'))
        `).run(`Auto-replied to prospect ${fromEmail} — subject: ${subject}`);

        // Notify via Telegram
        const tgToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
        const tgChat = process.env['TELEGRAM_CHAT_ID'] ?? '';
        if (tgToken && tgChat) {
          const tgMsg = `Prospecto respondio: ${fromEmail}\nAsunto: ${subject}\n\nMaya les respondio automaticamente. Revisa el inbox si quieres ver el hilo.`;
          fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChat, text: tgMsg }),
          }).catch(() => {});
        }

        logger.info(`[prospect-poller] Auto-replied to ${fromEmail}`);
      } catch (err) {
        logger.error({ err, fromEmail }, '[prospect-poller] Failed to send reply');
      }
    }
  }

  // Expose as endpoint for manual trigger / healthcheck
  app.post('/api/gmail/poll-replies', async (_req: Request, res: Response) => {
    try {
      await pollProspectReplies();
      res.json({ ok: true, message: 'Prospect reply poll complete' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Auto-run every 15 minutes
  setInterval(() => {
    pollProspectReplies().catch(err => logger.error({ err }, '[prospect-poller] interval error'));
  }, 15 * 60 * 1000);

  // Run once on startup after a short delay (give server time to finish init)
  setTimeout(() => {
    pollProspectReplies().catch(err => logger.warn({ err }, '[prospect-poller] startup poll error'));
  }, 30_000);

  // Helper used by create_event: gets a fresh access token using refresh token
  async function getFreshGoogleToken(): Promise<string | null> {
    const row = db.prepare(`SELECT access_token, refresh_token, token_expiry FROM oauth_tokens WHERE provider = 'google'`).get() as { access_token: string; refresh_token: string | null; token_expiry: string } | undefined;
    if (!row) return null;

    // Check if current token is still valid (>2 min left)
    const expiresAt = new Date(row.token_expiry).getTime();
    if (Date.now() < expiresAt - 120000) return row.access_token;

    // Try to refresh
    if (!row.refresh_token) return null;

    const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
    const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] || '';

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: row.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
    });
    const data = await res.json() as { access_token?: string; expires_in?: number; error?: string };
    if (!data.access_token) return null;

    const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    db.prepare(`UPDATE oauth_tokens SET access_token = ?, token_expiry = ?, updated_at = datetime('now') WHERE provider = 'google'`).run(data.access_token, newExpiry);
    return data.access_token;
  }

  // ── VAPI TOOL CALLS ───────────────────────────────────────────────
  // Handles real-time tool execution during Thorn phone calls.
  // Vapi calls this endpoint when the AI needs to fetch data mid-call.
  app.post('/api/vapi', async (req: Request, res: Response) => {
    try {
      const { message } = req.body as {
        message: {
          type: string;
          toolCallList?: Array<{
            id: string;
            name?: string;
            arguments?: Record<string, string>;
            function?: { name: string; arguments: Record<string, string> };
          }>;
        };
      };

      if (message?.type !== 'tool-calls' || !message.toolCallList?.length) {
        // Handle lifecycle events that Vapi routes here via the assistant's serverUrl.
        // When an assistant has a serverUrl, Vapi sends ALL server messages (call-started,
        // end-of-call-report, transcript, etc.) to the assistant serverUrl — not the phone
        // number serverUrl. So we must handle them here, not just in /api/vapi/inbound.
        const body = req.body as Record<string, unknown>;
        const msgBody = (body['message'] as Record<string, unknown> | undefined) ?? body;
        const msgType = msgBody['type'] as string | undefined;
        const pushFnV = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;

        if (msgType === 'call-started') {
          const callObj = (msgBody['call'] as Record<string, unknown> | undefined) ?? {};
          const vapiCallIdV = (callObj['id'] as string | undefined) ?? '';
          logger.info({ vapiCallId: vapiCallIdV }, '[vapi] call-started');
          if (vapiCallIdV) {
            const callTypeV = (callObj['type'] as string | undefined) ?? '';
            const isInboundV = callTypeV === 'inboundPhoneCall';
            const customerV = (callObj['customer'] as Record<string, unknown> | undefined) ?? {};
            const callerNumV = (customerV['number'] as string | undefined) ?? '';
            const startedAtV = (callObj['startedAt'] as string | undefined) ?? new Date().toISOString();
            const existingV = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdV);
            if (!existingV) {
              const idObjV = isInboundV && callerNumV ? checkCallerIdentity(callerNumV) : null;
              const callerNameV = idObjV?.name ?? callerNumV;
              const directionV = isInboundV ? 'inbound' : 'outbound';
              const newIdV = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              db.prepare(`INSERT OR IGNORE INTO calls (id, vapi_call_id, to_number, contact_name, objective, direction, status, caller_allowed, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, datetime('now'))`).run(newIdV, vapiCallIdV, callerNumV, callerNameV, isInboundV ? 'Llamada entrante' : '', directionV, idObjV?.allowed ? 1 : 0, startedAtV);
              db.prepare(`UPDATE agents SET status = 'working', current_task = ?, updated_at = unixepoch() WHERE id = 'thorn'`).run(`En llamada${callerNumV ? ` con ${callerNameV || callerNumV}` : ''}`);
              cacheInvalidate('calls');
              if (pushFnV) {
                const newCallRowV = db.prepare(`SELECT * FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdV);
                pushFnV(`data: ${JSON.stringify({ type: 'call_started', call: newCallRowV })}\n\n`);
                const allCallsV = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
                pushFnV(`data: ${JSON.stringify({ type: 'calls', rows: allCallsV })}\n\n`);
              }
            } else {
              // Guard: only update to in_progress if not already completed/ended
              db.prepare(`UPDATE calls SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE vapi_call_id = ? AND status NOT IN ('completed','missed','answered','voicemail','blocked')`).run(startedAtV, vapiCallIdV);
              cacheInvalidate('calls');
              if (pushFnV) {
                const allCallsV2 = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
                pushFnV(`data: ${JSON.stringify({ type: 'calls', rows: allCallsV2 })}\n\n`);
              }
            }
          }

        } else if (msgType === 'call-ended' || msgType === 'end-of-call-report') {
          const callObj = (msgBody['call'] as Record<string, unknown> | undefined) ?? {};
          const vapiCallIdE = (callObj['id'] as string | undefined) ?? '';
          const endedReasonE = (callObj['endedReason'] as string | undefined) ?? (msgBody['endedReason'] as string | undefined) ?? '';
          const startedAtE = (callObj['startedAt'] as string | undefined);
          const endedAtE = (callObj['endedAt'] as string | undefined) ?? new Date().toISOString();
          const artifactE = (msgBody['artifact'] as Record<string, unknown> | undefined) ?? {};
          const rawTranscriptE = (artifactE['transcript'] as string | undefined) ?? '';
          const durationSecondsE = (startedAtE && endedAtE) ? Math.round((new Date(endedAtE).getTime() - new Date(startedAtE).getTime()) / 1000) : 0;
          const summaryMapE: Record<string, string> = { 'customer-ended-call': 'Completada', 'silence-timed-out': 'Sin respuesta', 'customer-did-not-answer': 'No contesto', 'voicemail': 'Buzon de voz', 'assistant-ended-call': 'Completada', 'max-duration-exceeded': 'Duracion maxima' };
          const summaryE = summaryMapE[endedReasonE] ?? endedReasonE ?? 'Desconocido';
          const failedE = ['silence-timed-out', 'customer-did-not-answer', 'no-answer', 'busy'];
          const partialE = ['voicemail', 'max-duration-exceeded'];
          const objAchievedE = (!failedE.includes(endedReasonE) && !partialE.includes(endedReasonE)) ? 1 : 0;
          const outcomeE = failedE.includes(endedReasonE) ? 'failed' : partialE.includes(endedReasonE) ? 'partial' : objAchievedE ? 'success' : 'partial';
          logger.info({ vapiCallId: vapiCallIdE, endedReason: endedReasonE, durationSeconds: durationSecondsE }, '[vapi] call-ended/end-of-call-report');
          if (vapiCallIdE) {
            const endedRowE = db.prepare(`SELECT id, contact_name, objective FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdE) as { id: string; contact_name: string; objective: string } | undefined;
            if (endedRowE) {
              db.prepare(`UPDATE calls SET status = 'completed', transcript = ?, duration_seconds = ?, outcome = ?, summary = ?, objective_achieved = ?, ended_reason = ?, ended_at = ? WHERE vapi_call_id = ?`).run(rawTranscriptE, durationSecondsE, outcomeE, summaryE, objAchievedE, endedReasonE, endedAtE, vapiCallIdE);
            } else {
              // Call record was never created (call-started was missed) — create it now
              const callTypeE = (callObj['type'] as string | undefined) ?? '';
              const customerE = (callObj['customer'] as Record<string, unknown> | undefined) ?? {};
              const callerNumE = (customerE['number'] as string | undefined) ?? '';
              const isInboundE = callTypeE === 'inboundPhoneCall';
              const idObjE = isInboundE && callerNumE ? checkCallerIdentity(callerNumE) : null;
              const newIdE = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              db.prepare(`INSERT OR IGNORE INTO calls (id, vapi_call_id, to_number, contact_name, objective, direction, status, caller_allowed, transcript, duration_seconds, outcome, summary, objective_achieved, ended_reason, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(newIdE, vapiCallIdE, callerNumE, idObjE?.name ?? callerNumE, isInboundE ? 'Llamada entrante' : '', isInboundE ? 'inbound' : 'outbound', idObjE?.allowed ? 1 : 0, rawTranscriptE, durationSecondsE, outcomeE, summaryE, objAchievedE, endedReasonE, startedAtE ?? null, endedAtE);
            }
            db.prepare(`UPDATE agents SET status = 'active', current_task = NULL, updated_at = unixepoch() WHERE id = 'thorn' AND status = 'working'`).run();
            db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`).run(`Llamada terminada: ${endedRowE?.contact_name ?? vapiCallIdE} — ${summaryE}`);
            cacheInvalidate('calls');
            if (pushFnV) {
              pushFnV(`data: ${JSON.stringify({ type: 'call_ended', vapiCallId: vapiCallIdE, outcome: outcomeE })}\n\n`);
              const allCallsE = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
              pushFnV(`data: ${JSON.stringify({ type: 'calls', rows: allCallsE })}\n\n`);
            }
            // Notify Gonzalo via Telegram — atomic claim prevents duplicates from other endpoints
            void (async () => {
              const notifyClaimV = db.prepare(`UPDATE calls SET notification_sent = 1 WHERE vapi_call_id = ? AND (notification_sent IS NULL OR notification_sent = 0)`).run(vapiCallIdE);
              if (notifyClaimV.changes === 0) return;
              const botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
              const chatId = process.env['ALLOWED_CHAT_ID'] ?? '';
              if (botToken && chatId) {
                await notifyCallEnded({ botToken, chatId, contactName: endedRowE?.contact_name ?? vapiCallIdE, objective: endedRowE?.objective ?? '', durationSeconds: durationSecondsE, callSummary: summaryE, transcript: rawTranscriptE, logPrefix: 'vapi' });
              }
            })();
          }

        } else if (msgType === 'transcript') {
          const callObj = (msgBody['call'] as Record<string, unknown> | undefined) ?? {};
          const vapiCallIdT = (callObj['id'] as string | undefined) ?? '';
          const role = (msgBody['role'] as string | undefined) ?? '';
          const text = (msgBody['transcript'] as string | undefined) ?? '';
          const isFinal = (msgBody['transcriptType'] as string | undefined) === 'final' ? 1 : 0;
          if (vapiCallIdT && text && isFinal) {
            try {
              const callRowT = db.prepare(`SELECT id FROM calls WHERE vapi_call_id = ?`).get(vapiCallIdT) as { id: string } | undefined;
              if (callRowT) {
                const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                db.prepare(`INSERT OR IGNORE INTO call_transcripts (id, call_id, vapi_call_id, role, text, is_final, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(turnId, callRowT.id, vapiCallIdT, role, text, isFinal);
                if (pushFnV) {
                  const turns = db.prepare(`SELECT * FROM call_transcripts WHERE vapi_call_id = ? ORDER BY created_at ASC`).all(vapiCallIdT);
                  pushFnV(`data: ${JSON.stringify({ type: 'call_transcript', rows: turns })}\n\n`);
                }
                logger.info({ vapiCallId: vapiCallIdT, role, isFinal, len: text.length }, '[vapi] transcript turn saved');
              }
            } catch (tErr) { logger.warn({ err: tErr }, '[vapi] failed to save transcript turn'); }
          }
        }

        res.json({ results: [] });
        return;
      }

      const results = await Promise.all(
        message.toolCallList.map(async (call) => {
          // Vapi sends tool name/args inside call.function, not at the top level
          const toolName = call.function?.name ?? call.name ?? '';
          // Vapi sends function.arguments as a JSON string — parse it if needed
          const rawArgs = call.function?.arguments ?? call.arguments ?? {};
          const toolArgs: Record<string, string> = typeof rawArgs === 'string'
            ? (() => { try { return JSON.parse(rawArgs) as Record<string, string>; } catch { return {}; } })()
            : rawArgs as Record<string, string>;
          let result = '';

          try {
            if (toolName === 'check_calendar') {
              // Returns today's and tomorrow's events
              const now = new Date();
              const todayStart = now.toISOString().split('T')[0] + 'T00:00:00';
              const tomorrowEnd = new Date(now.getTime() + 2 * 86400000).toISOString().split('T')[0] + 'T23:59:59';
              const events = db.prepare(
                `SELECT title, start_time, end_time, description FROM calendar_events
                 WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC LIMIT 10`
              ).all(todayStart, tomorrowEnd) as Array<{ title: string; start_time: string; end_time: string; description: string | null }>;

              if (events.length === 0) {
                result = 'No hay eventos en calendario hoy ni manana.';
              } else {
                result = events.map(e => {
                  const start = new Date(e.start_time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/Monterrey' });
                  return `${start} — ${e.title}`;
                }).join('\n');
              }

            } else if (toolName === 'create_event') {
              const { title, date, time, duration, description: evDesc } = toolArgs;
              if (!title || !date) { result = 'Falta titulo o fecha del evento.'; }
              else {
                const startStr = time ? `${date}T${time}:00` : `${date}T09:00:00`;
                const durationMin = parseInt(duration || '60', 10);
                const startMs = new Date(startStr).getTime();
                const endMs = startMs + durationMin * 60000;
                const endIso = new Date(endMs).toISOString();
                const startIso = new Date(startMs).toISOString();

                // Try Google Calendar API first (auto-refreshes token)
                const freshToken = await getFreshGoogleToken();
                let createdInGoogle = false;

                if (freshToken) {
                  const gcalRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer ${freshToken}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      summary: title,
                      description: evDesc || '',
                      start: { dateTime: startIso, timeZone: 'America/Monterrey' },
                      end: { dateTime: endIso, timeZone: 'America/Monterrey' },
                    }),
                  });
                  if (gcalRes.ok) {
                    createdInGoogle = true;
                    const gcalEvent = await gcalRes.json() as { id: string };
                    // Also save locally for dashboard sync
                    db.prepare(
                      `INSERT OR IGNORE INTO calendar_events (id, title, description, start_time, end_time, type, source, external_id)
                       VALUES (?, ?, ?, ?, ?, 'meeting', 'thorn', ?)`
                    ).run(`event-${Date.now()}`, title, evDesc || '', startStr, new Date(endMs).toISOString().replace('Z', ''), gcalEvent.id);
                  }
                }

                if (createdInGoogle) {
                  result = `Listo, agendé "${title}" el ${date}${time ? ' a las ' + time : ''} en tu Google Calendar.`;
                } else {
                  // Fallback: save locally only
                  db.prepare(
                    `INSERT INTO calendar_events (id, title, description, start_time, end_time, type, source)
                     VALUES (?, ?, ?, ?, ?, 'meeting', 'thorn')`
                  ).run(`event-${Date.now()}`, title, evDesc || '', startStr, new Date(endMs).toISOString().replace('Z', ''));
                  result = `Lo agendé localmente como "${title}" el ${date}${time ? ' a las ' + time : ''}. Para que aparezca en Google Calendar abre el dashboard y reconecta Google.`;
                }
              }

            } else if (toolName === 'create_task') {
              const { title, description, assignee } = toolArgs;
              if (!title) { result = 'Falta el titulo de la tarea.'; }
              else {
                const id = `task-${Date.now()}`;
                db.prepare(
                  `INSERT INTO agent_tasks (id, title, description, assignee_id, assignee_name, status, priority)
                   VALUES (?, ?, ?, ?, ?, 'todo', 'medium')`
                ).run(id, title, description || '', assignee || 'thorn', assignee || 'Thorn');
                result = `Tarea creada: "${title}"`;
              }

            } else if (toolName === 'save_note') {
              const { content, title: noteTitle } = toolArgs;
              if (!content) { result = 'Falta el contenido de la nota.'; }
              else {
                db.prepare(
                  `INSERT INTO brain_vault (title, content, type, agent_id, agent_name, department, folder_path)
                   VALUES (?, ?, 'note', 'thorn', 'Thorn', 'executive', 'Varios')`
                ).run(noteTitle || `Nota llamada ${new Date().toLocaleDateString('es-MX')}`, content);
                result = 'Nota guardada en BrainVault.';
              }

            } else if (toolName === 'web_search') {
              const { query } = toolArgs;
              if (!query) { result = 'Falta la busqueda.'; }
              else {
                // Use OpenAI Responses API with web_search_preview tool
                const openaiKey = process.env['OPENAI_API_KEY'] || '';
                const searchRes = await fetch('https://api.openai.com/v1/responses', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                  body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    tools: [{ type: 'web_search_preview' }],
                    input: `Busca en internet y responde en español en máximo 2 oraciones cortas y directas: ${query}`,
                  }),
                });
                const searchData = await searchRes.json() as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };
                const textOutput = searchData.output?.find(o => o.type === 'message');
                result = textOutput?.content?.find(c => c.type === 'output_text')?.text?.trim() || `No encontré información sobre: ${query}`;
              }

            } else if (toolName === 'send_telegram') {
              const { message: tgMsg } = toolArgs;
              if (!tgMsg) { result = 'Falta el mensaje.'; }
              else {
                const botToken = process.env['TELEGRAM_BOT_TOKEN'] || '';
                const chatId = process.env['ALLOWED_CHAT_ID'] || '';
                const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: chatId, text: tgMsg }),
                });
                result = tgRes.ok ? 'Mensaje enviado por Telegram.' : 'Error enviando el mensaje.';
              }

            } else if (toolName === 'send_message_to_gonzalo') {
              // Used by stranger assistant to notify Gonzalo via Telegram
              const { caller_name, message: strangerMsg, caller_phone } = toolArgs;
              if (!caller_name || !strangerMsg) { result = 'Falta nombre o mensaje del visitante.'; }
              else {
                const botToken = process.env['TELEGRAM_BOT_TOKEN'] || '';
                const chatId = process.env['ALLOWED_CHAT_ID'] || '';
                const phoneNote = caller_phone ? ` (${caller_phone})` : '';
                const tgText = `Mensaje de ${caller_name}${phoneNote}: ${strangerMsg}`;
                const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: chatId, text: tgText }),
                });
                // Log to activity feed
                db.prepare(
                  `INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
                   VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`
                ).run(`Mensaje de visitante: ${caller_name} — ${strangerMsg.slice(0, 80)}`);
                result = tgRes.ok
                  ? `Listo. Gonzalo sera notificado sobre tu mensaje, ${caller_name}.`
                  : 'Hubo un problema al enviar el mensaje. Intenta llamar mas tarde.';
              }

            } else if (toolName === 'read_emails') {
              const token = await getFreshGoogleToken();
              if (!token) { result = 'No hay conexion con Gmail. Reconecta Google en el dashboard.'; }
              else {
                const gmailRes = await fetch(
                  'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=is:unread',
                  { headers: { Authorization: `Bearer ${token}` } }
                );
                const gmailData = await gmailRes.json() as { messages?: Array<{ id: string }> };
                const ids = gmailData.messages?.slice(0, 5) || [];
                if (ids.length === 0) { result = 'No tienes emails sin leer.'; }
                else {
                  const emails = await Promise.all(ids.map(async ({ id }) => {
                    const msgRes = await fetch(
                      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
                      { headers: { Authorization: `Bearer ${token}` } }
                    );
                    const msg = await msgRes.json() as { payload?: { headers?: Array<{ name: string; value: string }> } };
                    const headers = msg.payload?.headers || [];
                    const subject = headers.find(h => h.name === 'Subject')?.value || '(sin asunto)';
                    const from = headers.find(h => h.name === 'From')?.value || '';
                    const sender = from.replace(/<.*>/, '').trim() || from;
                    return `${sender}: ${subject}`;
                  }));
                  result = `Tienes ${ids.length} emails sin leer:\n${emails.join('\n')}`;
                }
              }

            } else if (toolName === 'lookup_contact') {
              const { name } = toolArgs;
              if (!name) { result = 'Falta el nombre del contacto.'; }
              else {
                const contacts = db.prepare(
                  `SELECT name, phone, email, notes FROM contacts WHERE name LIKE ? LIMIT 5`
                ).all(`%${name}%`) as Array<{ name: string; phone: string | null; email: string | null; notes: string | null }>;
                if (contacts.length === 0) {
                  result = `No encontré a "${name}" en los contactos.`;
                } else {
                  result = contacts.map(c => {
                    const parts = [c.name];
                    if (c.phone) parts.push(`tel: ${c.phone}`);
                    if (c.email) parts.push(`email: ${c.email}`);
                    if (c.notes) parts.push(`nota: ${c.notes}`);
                    return parts.join(' | ');
                  }).join('\n');
                }
              }

            } else if (toolName === 'make_call') {
              const { phone_number, task, create_event_on_success, event_title, event_date, event_time } = toolArgs;
              if (!phone_number || !task) { result = 'Falta numero o instrucciones.'; }
              else {
                // Normalize phone number to E.164 format (+52XXXXXXXXXX)
                let normalized = phone_number.replace(/[\s\-().]/g, '');
                if (!normalized.startsWith('+')) {
                  // Assume Mexico if 10 digits, else prepend +52
                  const digits = normalized.replace(/\D/g, '');
                  if (digits.length === 10) normalized = `+52${digits}`;
                  else if (digits.length === 12 && digits.startsWith('52')) normalized = `+${digits}`;
                  else normalized = `+${digits}`;
                }
                const vapiKey = process.env['VAPI_API_KEY'] || '';
                const phoneId = process.env['VAPI_PHONE_NUMBER_ID'] || '';
                const voiceId = process.env['ELEVENLABS_VOICE_ID'] || '';
                const thornAssistantIdOutbound = process.env['VAPI_ASSISTANT_ID'] ?? 'b12b30d9-a75b-48de-a19b-b494e1eaa1a3';
                const today = new Date().toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Monterrey' });

                // Resolve contact name from contacts table
                const cleanNorm = normalized.replace(/\s+/g, '');
                const resolvedContact = db.prepare(
                  `SELECT name FROM contacts WHERE replace(phone,' ','') = ? OR replace(phone,' ','') LIKE ? LIMIT 1`
                ).get(cleanNorm, `%${cleanNorm.slice(-10)}`) as { name: string } | undefined;
                const contactName = resolvedContact?.name ?? normalized;

                const callRes = await fetch('https://api.vapi.ai/call', {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${vapiKey}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    phoneNumberId: phoneId,
                    customer: { number: normalized },
                    assistantId: thornAssistantIdOutbound,
                    assistantOverrides: {
                      firstMessage: 'Hola, buenas tardes.',
                      model: {
                        messages: [{
                          role: 'system',
                          content: `Eres Thorn, COO de OpoClaw, llamando en nombre de ${process.env['OWNER_NAME'] || 'el propietario'}. Hoy es ${today}. Tu tarea en esta llamada: ${task}. Habla en español natural y directo — sin rodeos, sin clichés de AI, sin emojis. Cuando termines la llamada, di exactamente lo que respondió la persona.`,
                        }],
                      },
                    },
                  }),
                });
                const callData = await callRes.json() as { id?: string; message?: string };

                if (!callData.id) {
                  result = `No se pudo iniciar la llamada: ${callData.message || 'error'}`;
                } else {
                  // Log the call to the calls table so it shows in the dashboard
                  try {
                    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    db.prepare(`
                      INSERT INTO calls (id, vapi_call_id, to_number, contact_name, objective, status, direction, started_at, created_at)
                      VALUES (?, ?, ?, ?, ?, 'queued', 'outbound', datetime('now'), datetime('now'))
                    `).run(callId, callData.id, normalized, contactName, task);
                    // Push immediate SSE update so the live banner appears instantly.
                    // Without this the banner only shows after the 1-second SSE poller fires,
                    // which may be after call-started/call-ended webhooks already arrived.
                    const pushFnMC = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
                    if (pushFnMC) {
                      const allCallsMC = db.prepare(`SELECT * FROM calls ORDER BY created_at DESC LIMIT 50`).all();
                      pushFnMC(`data: ${JSON.stringify({ type: 'calls', rows: allCallsMC })}\n\n`);
                    }
                  } catch (_logErr) { /* non-fatal */ }

                  // Optionally pre-create calendar event
                  if (create_event_on_success === 'true' && event_title && event_date) {
                    const freshToken = await getFreshGoogleToken();
                    if (freshToken) {
                      const startStr = event_time ? `${event_date}T${event_time}:00` : `${event_date}T20:00:00`;
                      const endIso = new Date(new Date(startStr).getTime() + 90 * 60000).toISOString();
                      await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          summary: event_title,
                          start: { dateTime: new Date(startStr).toISOString(), timeZone: 'America/Monterrey' },
                          end: { dateTime: endIso, timeZone: 'America/Monterrey' },
                        }),
                      });
                      result = `Llamada iniciada al ${phone_number} y evento "${event_title}" agendado en tu calendario.`;
                    } else {
                      result = `Llamada iniciada al ${phone_number}. No pude agendar el evento (reconecta Google Calendar).`;
                    }
                  } else {
                    result = `Llamada iniciada al ${normalized}. ID: ${callData.id}.`;
                  }
                }
              }

            } else if (toolName === 'delegate_to_thorn') {
              // Routes the instruction into the Thorn agent pipeline via /api/agents/run.
              // This spawns a Claude Code sub-agent process with the full instruction,
              // identical to how tasks delegated from Telegram are handled.
              // Note: sending via Telegram sendMessage does NOT work because the bot
              // only processes messages from Gonzalo — it ignores its own outbound messages.
              const { instruction } = toolArgs;
              if (!instruction) { result = 'Falta la instruccion para delegar.'; }
              else {
                try {
                  const runRes = await fetch('http://localhost:3001/api/agents/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      agent_id: 'thorn',
                      task: `[Desde llamada] ${instruction}`,
                    }),
                  });
                  const runBody = await runRes.json() as Record<string, unknown>;
                  if (runRes.ok && runBody['ok']) {
                    // Log to activity feed
                    db.prepare(
                      `INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
                       VALUES ('thorn', 'Thorn', '🌵', ?, 'task', 'executive', datetime('now'))`
                    ).run(`Delegado desde llamada: ${instruction.slice(0, 100)}`);
                    result = 'Delegado. El equipo lo toma y te manda el resultado por Telegram.';
                  } else {
                    result = 'No pude procesar la instruccion. Intenta de nuevo.';
                  }
                } catch (delegateErr) {
                  result = `Error al delegar: ${String(delegateErr)}`;
                }
              }

            } else {
              result = `Herramienta desconocida: ${toolName}`;
            }
          } catch (toolErr) {
            result = `Error ejecutando ${toolName}: ${String(toolErr)}`;
          }

          return { toolCallId: call.id, result };
        })
      );

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Dashboard Chat ────────────────────────────────────────────────

  // GET /api/chat/history
  app.get('/api/chat/history', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare('SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 100').all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/chat/upload — accept base64 file in JSON, save to disk
  app.post('/api/chat/upload', async (req: Request, res: Response) => {
    try {
      const { name, type, data } = req.body as { name: string; type: string; data: string };
      if (!name || !data) return res.status(400).json({ error: 'name and data required' });
      const filename = `${Date.now()}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      res.json({ path: filePath, name, type });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/chat/message — SSE streaming: runs Thorn with the same session as Telegram
  app.post('/api/chat/message', async (req: Request, res: Response) => {
    const { message = '', files: attachedFiles = [] } = req.body as {
      message: string;
      files: Array<{ name: string; type: string; data: string }>;
    };

    if (!message.trim() && attachedFiles.length === 0) {
      return res.status(400).json({ error: 'message required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({ type: 'thinking', text: 'Conectando con Thorn...' });

    try {
      // Save any attached files to disk
      const savedFiles: Array<{ name: string; type: string; path: string }> = [];
      for (const f of attachedFiles) {
        if (!f.data) continue;
        const filename = `${Date.now()}_${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const filePath = path.join(UPLOADS_DIR, filename);
        fs.writeFileSync(filePath, Buffer.from(f.data, 'base64'));
        savedFiles.push({ name: f.name, type: f.type, path: filePath });
      }

      // Build message with file references so Claude Code can read/analyze them
      let fullMessage = message;
      if (savedFiles.length > 0) {
        const refs = savedFiles.map(f => {
          if (f.type.startsWith('image/')) return `[Image attached, analyze it: ${f.path}]`;
          if (f.type.startsWith('audio/')) return `[Audio file: ${f.path}]`;
          if (f.type.startsWith('video/')) return `[Video file: ${f.path}]`;
          return `[Document attached, read it: ${f.path}]`;
        });
        fullMessage = message ? `${message}\n\n${refs.join('\n')}` : refs.join('\n');
      }

      // Use the same Thorn session as Telegram (shared memory/context)
      const sessionRow = db.prepare(
        'SELECT session_id, chat_id FROM sessions ORDER BY updated_at DESC LIMIT 1'
      ).get() as { session_id: string; chat_id: string } | undefined;

      // Persist user message
      db.prepare('INSERT INTO chat_messages (role, content, files) VALUES (?, ?, ?)').run(
        'user', message, savedFiles.length > 0 ? JSON.stringify(savedFiles) : null
      );

      const result = await runAgent(
        fullMessage,
        sessionRow?.session_id,
        () => send({ type: 'thinking', text: 'Pensando...' }),
        (event) => send({ type: 'progress', text: event.description }),
      );

      // Keep session in sync so both Telegram and dashboard share context
      if (result.newSessionId) {
        if (sessionRow) {
          db.prepare("UPDATE sessions SET session_id = ?, updated_at = datetime('now') WHERE chat_id = ?")
            .run(result.newSessionId, sessionRow.chat_id);
        } else {
          db.prepare("INSERT OR REPLACE INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, datetime('now'))")
            .run('dashboard', result.newSessionId);
        }
      }

      const responseText = result.text ?? '';
      db.prepare('INSERT INTO chat_messages (role, content) VALUES (?, ?)').run('assistant', responseText);
      send({ type: 'done', text: responseText });

    } catch (err) {
      logger.error({ err }, 'Chat message error');
      send({ type: 'error', text: String(err) });
    } finally {
      res.end();
    }
  });

  // ── GET /api/agents/:id/stats — real stats per agent ─────────────
  app.get('/api/agents/:id/stats', (req: Request, res: Response) => {
    try {
      const agentId = req.params.id as string;
      const tasks = db.prepare(`
        SELECT status, COUNT(*) as cnt FROM tasks WHERE assignee_id = ? GROUP BY status
      `).all(agentId) as Array<{ status: string; cnt: number }>;

      let total = 0, done = 0, inProgress = 0;
      for (const row of tasks) {
        total += row.cnt;
        const s = (row.status ?? '').toLowerCase().replace(/\s+/g, '_');
        if (s === 'done') done += row.cnt;
        if (s === 'in_progress') inProgress += row.cnt;
      }

      const costRow = db.prepare(`
        SELECT COALESCE(SUM(cost_usd), 0) as cost
        FROM llm_costs WHERE agent_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
      `).get(agentId) as { cost: number };

      const activityRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM agent_activity WHERE agent_id = ? AND created_at >= datetime('now', '-24 hours')
      `).get(agentId) as { cnt: number };

      res.json({
        total, done, inProgress,
        successRate: total > 0 ? Math.round((done / total) * 100) : 0,
        costThisMonth: (costRow?.cost ?? 0).toFixed(4),
        activityToday: activityRow?.cnt ?? 0,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/agents/:id/iq — latest IQ score for an agent ──────────
  app.get('/api/agents/:id/iq', (req: Request, res: Response) => {
    try {
      const agentId = req.params.id as string;
      const row = db.prepare(`
        SELECT iq_score, success_count, fail_count, task_count, date
        FROM agent_iq
        WHERE agent_id = ?
        ORDER BY date DESC
        LIMIT 1
      `).get(agentId) as { iq_score: number; success_count: number; fail_count: number; task_count: number; date: string } | undefined;

      if (!row) {
        return res.json({ iq_score: null, success_count: 0, fail_count: 0, task_count: 0, date: null });
      }
      return res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Ensure agent_chat_history table exists ──────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ach_agent_session ON agent_chat_history(agent_id, session_id);
  `);

  // ── GET /api/agents/:id/chat/history — load previous chat messages ──────────
  app.get('/api/agents/:id/chat/history', (req: Request, res: Response) => {
    try {
      const agentId = req.params.id as string;
      const sessionId = (req.query['sessionId'] as string | undefined) ?? '';
      if (!sessionId) { return res.json([]); }
      const rows = db.prepare(
        `SELECT role, content, created_at FROM agent_chat_history WHERE agent_id = ? AND session_id = ? ORDER BY id ASC LIMIT 200`
      ).all(agentId, sessionId);
      return res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/agents/:id/chat — SSE streaming chat with any agent ──
  app.post('/api/agents/:id/chat', async (req: Request, res: Response) => {
    const agentId = req.params.id as string;
    const { message = '', sessionId: clientSessionId } = req.body as { message: string; sessionId?: string };
    if (!message.trim()) { res.status(400).json({ error: 'message required' }); return; }

    const agentRow = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, string> | undefined;
    if (!agentRow) { res.status(404).json({ error: 'Agent not found' }); return; }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      // Store user message in history if sessionId provided
      if (clientSessionId) {
        db.prepare(
          `INSERT INTO agent_chat_history (agent_id, session_id, role, content) VALUES (?, ?, 'user', ?)`
        ).run(agentId, clientSessionId, message.trim());
      }

      // Load knowledge file if it exists
      let knowledgeContext = '';
      try {
        const { readFileSync } = await import('fs');
        const knowledgePath = `/Users/opoclaw1/claudeclaw/workspace/agents/${agentId}/knowledge.md`;
        knowledgeContext = readFileSync(knowledgePath, 'utf8');
      } catch {
        // No knowledge file — fine
      }

      // For Thorn use the shared Telegram session; for others use a fresh context with persona
      let agentSessionId: string | undefined;
      let fullMessage = message;

      if (agentId === 'thorn') {
        const sessionRow = db.prepare(
          'SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT 1'
        ).get() as { session_id: string } | undefined;
        agentSessionId = sessionRow?.session_id;
      } else {
        // Prepend persona so the agent responds in character
        const knowledgeSection = knowledgeContext
          ? `\n\nYour knowledge base:\n${knowledgeContext.slice(0, 4000)}`
          : '';
        fullMessage = `[CONTEXT: You are ${agentRow['full_name'] ?? agentRow['name']}, ${agentRow['title']} at OpoClaw. Department: ${agentRow['department']}. Respond in first person as ${agentRow['name']} — direct, professional, no fluff. Never reveal you are an AI unless asked directly. The message below is from Gonzalo, the CEO.${knowledgeSection}]\n\n${message}`;
      }

      const result = await runAgent(
        fullMessage,
        agentSessionId,
        () => send({ token: '' }),
        (event) => send({ token: '' }),
      );

      const replyText = result.text ?? '';

      // Emit the full reply as tokens (word-by-word for streaming feel)
      const words = replyText.split(' ');
      for (let i = 0; i < words.length; i++) {
        const token = (i === 0 ? '' : ' ') + words[i];
        send({ token });
        // Small yield to allow headers to flush
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Store assistant reply in history
      if (clientSessionId && replyText) {
        db.prepare(
          `INSERT INTO agent_chat_history (agent_id, session_id, role, content) VALUES (?, ?, 'assistant', ?)`
        ).run(agentId, clientSessionId, replyText);
      }

      // Log activity
      db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
        VALUES (?, ?, ?, ?, 'info', ?, datetime('now'))`
      ).run(agentId, agentRow['name'], agentRow['emoji'], `Chat: ${message.slice(0, 80)}`, agentRow['department']);

      send({ token: '', done: true });
      res.write('data: [DONE]\n\n');
    } catch (err) {
      logger.error({ err }, `Agent chat error for ${agentId}`);
      send({ error: String(err) });
    } finally {
      res.end();
    }
  });

  // ── People / Contacts endpoints ───────────────────────────────────

  // GET /api/people — list all contacts
  app.get('/api/people', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare(`SELECT * FROM people ORDER BY name COLLATE NOCASE ASC`).all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/people/search?q=name — search by name
  app.get('/api/people/search', (req: Request, res: Response) => {
    try {
      const q = (req.query['q'] as string | undefined) ?? '';
      const rows = db.prepare(`
        SELECT * FROM people
        WHERE name LIKE ? OR telegram_username LIKE ? OR email LIKE ?
        ORDER BY name COLLATE NOCASE ASC
        LIMIT 50
      `).all(`%${q}%`, `%${q}%`, `%${q}%`);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/people — create a new contact
  app.post('/api/people', (req: Request, res: Response) => {
    try {
      const { name, relation, telegram_username, telegram_chat_id, email, phone, whatsapp, notes } =
        req.body as {
          name?: string;
          relation?: string;
          telegram_username?: string;
          telegram_chat_id?: string;
          email?: string;
          phone?: string;
          whatsapp?: string;
          notes?: string;
        };
      if (!name?.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const result = db.prepare(`
        INSERT INTO people (name, relation, telegram_username, telegram_chat_id, email, phone, whatsapp, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name.trim(),
        relation ?? null,
        telegram_username ?? null,
        telegram_chat_id ?? null,
        email ?? null,
        phone ?? null,
        whatsapp ?? null,
        notes ?? null,
      );
      const newRow = db.prepare('SELECT * FROM people WHERE id = ?').get(result.lastInsertRowid);
      return res.status(201).json(newRow);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Error handler (must be before static catch-all) ──────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  // ── Serve React frontend ──────────────────────────────────────────
  const DIST = path.join(__dirname, '..', 'dashboard', 'dist');

  // Serve avatars directly from public/avatars so newly generated avatars
  // (created after the last build) are available without a rebuild.
  // Cache for 24 hours — avatars rarely change, and this eliminates the
  // repeated 1.6 MB downloads that were causing slow_requests entries.
  const PUBLIC_AVATARS = path.join(__dirname, '..', 'dashboard', 'public', 'avatars');
  app.use('/avatars', express.static(PUBLIC_AVATARS, {
    maxAge: '24h',
    etag: true,
    lastModified: true,
  }));

  // Serve venture demo pages directly from public/ventures (no rebuild needed when demos are added)
  const PUBLIC_VENTURES = path.join(__dirname, '..', 'dashboard', 'public', 'ventures');
  app.use('/ventures-demo', express.static(PUBLIC_VENTURES, {
    maxAge: '0',
    etag: true,
  }));

  // Serve venture deliverable content from workspace markdown files
  // GET /api/ventures/content?venture=cobrai&type=research|plan|pitch
  app.get('/api/ventures/content', (req: Request, res: Response) => {
    const { venture, type } = req.query as { venture?: string; type?: string };
    if (!venture || !type) {
      return res.status(400).json({ error: 'venture and type are required' });
    }
    const WORKSPACE = path.join(__dirname, '..', 'workspace');
    // Map (venture slug, type) to workspace file paths
    const slug = (venture as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const typeKey = (type as string).toLowerCase();
    const candidates: Record<string, string[]> = {
      research: [
        path.join(WORKSPACE, `${slug}-market-analysis.md`),
        path.join(WORKSPACE, `${slug}-research.md`),
        path.join(WORKSPACE, 'kaelen-market-analysis.md'),
        path.join(WORKSPACE, 'rafael-niche-research.md'),
      ],
      plan: [
        path.join(WORKSPACE, `${slug}-business-plan.md`),
        path.join(WORKSPACE, `${slug}-plan.md`),
      ],
      pitch: [
        path.join(WORKSPACE, `${slug}-pitch-deck.md`),
        path.join(WORKSPACE, `${slug}-pitch.md`),
      ],
    };
    const files = candidates[typeKey] || [];
    for (const filePath of files) {
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          return res.json({ content, source: path.basename(filePath) });
        } catch {
          // continue
        }
      }
    }
    return res.json({ content: null, source: null });
  });

  // GET /api/ventures/content/pdf?venture=cobrai&type=plan|pitch — download PDF
  app.get('/api/ventures/content/pdf', (req: Request, res: Response) => {
    const { venture, type } = req.query as { venture?: string; type?: string };
    if (!venture || !type) {
      return res.status(400).json({ error: 'venture and type are required' });
    }
    const WORKSPACE = path.join(__dirname, '..', 'workspace');
    const slug = (venture as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const typeKey = (type as string).toLowerCase();
    const pdfCandidates: Record<string, string[]> = {
      plan: [
        path.join(WORKSPACE, `${slug}-business-plan.pdf`),
        path.join(WORKSPACE, `${slug}-plan.pdf`),
      ],
      pitch: [
        path.join(WORKSPACE, `${slug}-mindfy-pitch-deck.pdf`),
        path.join(WORKSPACE, `${slug}-pitch-deck.pdf`),
        path.join(WORKSPACE, `${slug}-pitch.pdf`),
      ],
    };
    const files = pdfCandidates[typeKey] || [];
    for (const filePath of files) {
      if (fs.existsSync(filePath)) {
        const filename = path.basename(filePath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.sendFile(filePath);
      }
    }
    return res.status(404).json({ error: 'PDF not found' });
  });

  // List available venture demos (slugs with actual index.html files)
  app.get('/api/ventures/demos', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(PUBLIC_VENTURES)) {
        return res.json({ demos: [] });
      }
      const entries = fs.readdirSync(PUBLIC_VENTURES, { withFileTypes: true });
      const demos = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => fs.existsSync(path.join(PUBLIC_VENTURES, name, 'index.html')));
      res.json({ demos });
    } catch {
      res.json({ demos: [] });
    }
  });

  // ── Skills helpers ─────────────────────────────────────────────────
  // Skills can be either plain files (e.g. "gmail") or directories with SKILL.md inside.
  // This helper resolves the content file path for any skill entry.
  function resolveSkillContentPath(entryName: string): string | null {
    const entryPath = path.join(SKILLS_DIR, entryName);
    if (!fs.existsSync(entryPath)) return null;
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      const skillMd = path.join(entryPath, 'SKILL.md');
      return fs.existsSync(skillMd) ? skillMd : null;
    }
    // Plain file — treat as content regardless of extension
    return entryPath;
  }

  // ── Auto-generation maps: category + icon keyed by skill id ──────────────
  const SKILL_CATEGORY_MAP: Record<string, string> = {
    gmail: 'Communication', 'google-calendar': 'Calendar', todo: 'Productivity', 'morning-rollup': 'Calendar',
    'agent-browser': 'Productivity', 'n8n-builder': 'Business', maestro: 'Productivity',
    'make-image': 'Content', 'make-doc': 'Content', 'make-sheet': 'Content', 'make-diagram': 'Content', docsync: 'Content',
    'phone-call': 'Communication', 'cold-outreach': 'Business', 'social-scheduler': 'Content',
    'competitor-intel': 'Intelligence', factcheck: 'Intelligence', 'subreddit-scout': 'Intelligence',
    'brand-voice': 'Content', humanize: 'Content',
    'okr-tracker': 'Business', 'invoice-gen': 'Business', 'contract-gen': 'Business', 'expense-report': 'Business',
    'gtm-strategy': 'Business', 'lead-magnet': 'Business', 'meeting-prep': 'Calendar',
    'session-watchdog': 'Productivity', 'task-checkmate': 'Productivity', 'model-router': 'Productivity',
  };

  const SKILL_ICON_MAP: Record<string, string> = {
    gmail: 'Mail', 'google-calendar': 'CalendarDays', todo: 'ListTodo', 'morning-rollup': 'Sun',
    'agent-browser': 'Globe', 'n8n-builder': 'Workflow', maestro: 'Repeat2',
    'make-image': 'Image', 'make-doc': 'FileText', 'make-sheet': 'Table', 'make-diagram': 'GitBranch', docsync: 'Search',
    'phone-call': 'Phone', 'cold-outreach': 'Sparkles', 'social-scheduler': 'Share2',
    'competitor-intel': 'TrendingUp', factcheck: 'ShieldCheck', 'subreddit-scout': 'Compass',
    'brand-voice': 'Tag', humanize: 'Type',
    'okr-tracker': 'CheckSquare', 'invoice-gen': 'Receipt', 'contract-gen': 'FileSignature', 'expense-report': 'Bot',
    'gtm-strategy': 'Zap', 'lead-magnet': 'Magnet', 'meeting-prep': 'Users2',
    'session-watchdog': 'Activity', 'task-checkmate': 'Target', 'model-router': 'Cpu',
  };

  function parseSkillContent(id: string, contentPath: string) {
    const stat = fs.statSync(contentPath);
    const raw = fs.readFileSync(contentPath, 'utf-8');

    // Parse YAML frontmatter (--- ... ---) if present
    let fmDescription = '';
    let fmName = '';
    let body = raw;
    if (raw.startsWith('---')) {
      const fmEnd = raw.indexOf('\n---', 3);
      if (fmEnd !== -1) {
        const fm = raw.slice(3, fmEnd);
        const dMatch = fm.match(/^description:\s*(.+)$/m);
        const nMatch = fm.match(/^name:\s*(.+)$/m);
        if (dMatch) fmDescription = dMatch[1].trim().replace(/^["']|["']$/g, '');
        if (nMatch) fmName = nMatch[1].trim();
        body = raw.slice(fmEnd + 4);
      }
    }

    // Heading -> name
    const headingMatch = body.match(/^#\s+(.+)$/m);
    const name = fmName || (headingMatch ? headingMatch[1].trim() : id);

    // Description: frontmatter first, then first body paragraph after heading
    let description = fmDescription;
    if (!description) {
      const lines = body.split('\n');
      let pastHeading = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!pastHeading && trimmed.startsWith('#')) { pastHeading = true; continue; }
        if (pastHeading && trimmed && !trimmed.startsWith('#') && trimmed !== '---') { description = trimmed; break; }
      }
    }
    // Strip "Triggers on: ..." suffix that some descriptions include
    description = description.replace(/\.\s*[Tt]riggers?\s+on[:.].+$/, '').trim();

    // Auto-generate triggers from "Triggers on: x, y, z" pattern anywhere in the file
    const triggers: string[] = [];
    const triggerSrc = fmDescription + ' ' + body;
    const triggerLineMatch = triggerSrc.match(/[Tt]riggers?\s+on[:\s]+([^\n.]+)/);
    if (triggerLineMatch) {
      const parts = triggerLineMatch[1].split(/[",]+/)
        .map((s: string) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s: string) => s.length > 2 && s.length < 60 && !s.startsWith('['));
      triggers.push(...parts.slice(0, 5));
    }
    // Fallback: first few bullet-list items
    if (triggers.length === 0) {
      const bullets = body.match(/^[-*]\s+`?([^`\n,]{3,49})`?/gm);
      if (bullets) {
        for (const m of bullets.slice(0, 5)) {
          const t = m.replace(/^[-*]\s+`?/, '').replace(/`?$/, '').trim();
          if (t.length > 2 && t.length < 50) triggers.push(t);
        }
      }
    }

    const isStub = raw.includes('Skill not yet implemented') || raw.length < 80;

    return {
      id,
      name,
      description,
      content: raw,
      status: isStub ? 'stub' : 'active',
      category: SKILL_CATEGORY_MAP[id] || 'Other',
      icon: SKILL_ICON_MAP[id] || 'Zap',
      triggers,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  // ── GET /api/skills ───────────────────────────────────────────────
  // Lists all skills from ~/.claude/skills/ (files or SKILL.md inside dirs)
  app.get('/api/skills', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(SKILLS_DIR)) {
        return res.json([]);
      }
      const entries = fs.readdirSync(SKILLS_DIR).filter(f => !f.startsWith('.'));
      const skills: ReturnType<typeof parseSkillContent>[] = [];
      for (const entry of entries) {
        const id = entry.endsWith('.md') ? entry.slice(0, -3) : entry;
        const contentPath = resolveSkillContentPath(entry);
        if (!contentPath) continue; // skip dirs without SKILL.md
        try {
          skills.push(parseSkillContent(id, contentPath));
        } catch {
          // skip unreadable entries
        }
      }
      res.json(skills);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /api/skills/:id ───────────────────────────────────────────
  app.get('/api/skills/:id', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const cleanId = id.endsWith('.md') ? id.slice(0, -3) : id;
      // Try: plain file, plain file + .md, directory with SKILL.md
      const candidates = [cleanId, cleanId + '.md'];
      let contentPath: string | null = null;
      for (const candidate of candidates) {
        contentPath = resolveSkillContentPath(candidate);
        if (contentPath) break;
      }
      if (!contentPath) {
        return res.status(404).json({ error: 'Skill not found' });
      }
      res.json(parseSkillContent(cleanId, contentPath));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/skills/propose ──────────────────────────────────────
  // Creates a skill proposal task assigned to marcus-reyes. Does NOT write the file.
  app.post('/api/skills/propose', (req: Request, res: Response) => {
    try {
      const { prompt } = req.body as { prompt?: string };
      if (!prompt?.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      // Derive a tentative skill name from the prompt (first line / first ~50 chars)
      const tentativeName = prompt.trim().split('\n')[0].slice(0, 50);
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      // Use status='in_progress' + skip_worker=1 so the agent-worker never auto-claims this.
      // Skill review tasks are manual review items for Marcus — not autonomous execution targets.
      db.prepare(`
        INSERT INTO agent_tasks (id, title, description, assignee_id, assignee_name, department, priority, status, progress, skip_worker, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
      `).run(
        taskId,
        `Review proposed skill: ${tentativeName}`,
        prompt.trim(),
        'marcus-reyes',
        'Marcus',
        'engineering',
        'medium',
        'in_progress',
        now,
        now,
      );

      // Log to agent-messages feed
      db.prepare(`
        INSERT INTO agent_messages (thread_id, from_agent_id, from_agent_name, from_agent_emoji, message, message_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        taskId,
        'thorn',
        'Thorn',
        '🌵',
        `Nuevo skill propuesto para revision: "${tentativeName}". Prompt: ${prompt.trim().slice(0, 200)}`,
        'message',
      );

      cacheInvalidate('metrics');
      res.status(201).json({ task_id: taskId, message: 'Skill proposal created and assigned to Marcus for review.' });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── POST /api/skills ──────────────────────────────────────────────
  // Writes a skill file directly. Used by Marcus after reviewing a proposal.
  app.post('/api/skills', (req: Request, res: Response) => {
    try {
      const { id, content } = req.body as { id?: string; content?: string };
      if (!id?.trim()) {
        return res.status(400).json({ error: 'id is required' });
      }
      if (!content?.trim()) {
        return res.status(400).json({ error: 'content is required' });
      }

      // Sanitize id: only allow alphanumeric, hyphens, underscores
      const cleanId = id.trim().replace(/[^a-zA-Z0-9\-_]/g, '-').toLowerCase();
      if (!cleanId) {
        return res.status(400).json({ error: 'id contains no valid characters' });
      }

      if (!fs.existsSync(SKILLS_DIR)) {
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
      }

      const filePath = path.join(SKILLS_DIR, cleanId + '.md');
      // Prevent path traversal
      if (!filePath.startsWith(SKILLS_DIR)) {
        return res.status(400).json({ error: 'Invalid skill id' });
      }

      const isNew = !fs.existsSync(filePath);
      fs.writeFileSync(filePath, content.trim() + '\n', 'utf-8');
      const stat = fs.statSync(filePath);

      res.status(isNew ? 201 : 200).json({
        id: cleanId,
        path: filePath,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        created: isNew,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── DELETE /api/skills/:id ────────────────────────────────────────
  app.delete('/api/skills/:id', (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const cleanId = id.endsWith('.md') ? id.slice(0, -3) : id;
      const filePath = path.join(SKILLS_DIR, cleanId);
      const filePathMd = path.join(SKILLS_DIR, cleanId + '.md');

      // Prevent path traversal
      if (!filePath.startsWith(SKILLS_DIR)) {
        return res.status(400).json({ error: 'Invalid skill id' });
      }

      let resolvedPath: string | null = null;
      if (fs.existsSync(filePath)) resolvedPath = filePath;
      else if (fs.existsSync(filePathMd)) resolvedPath = filePathMd;

      if (!resolvedPath) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      fs.unlinkSync(resolvedPath);
      res.json({ ok: true, deleted: cleanId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });


  // ── VisionClaw / Glasses Gateway ─────────────────────────────────────
  // POST /v1/chat/completions — OpenAI-compatible endpoint for OpoclawBridge.swift
  // Called by the iOS app when glasses detect an `execute` tool call from Vapi/Gemini

  /**
   * Build memory context for cross-platform sync (glasses + VAPI calls).
   * Uses the same chat_id as Telegram (ALLOWED_CHAT_ID) so all platforms share one memory pool.
   */
  function buildCrossPlatformMemoryContext(userMessage: string): string {
    const gonzaloChatId = process.env['ALLOWED_CHAT_ID'] ?? '';
    if (!gonzaloChatId) return '';
    try {
      // FTS keyword search — top 3 relevant memories
      const sanitized = userMessage
        .replace(/[""]/g, '"').replace(/[^\w\s]/g, '').trim()
        .split(/\s+/).filter(Boolean).map((w) => `"${w}"*`).join(' ');
      const searched: Array<{ content: string; sector: string; id: number }> = sanitized
        ? (db.prepare(
            `SELECT memories.id, memories.content, memories.sector FROM memories
             JOIN memories_fts ON memories.id = memories_fts.rowid
             WHERE memories_fts MATCH ? AND memories.chat_id = ?
             ORDER BY rank LIMIT 3`
          ).all(sanitized, gonzaloChatId) as Array<{ content: string; sector: string; id: number }>)
        : [];
      const seenIds = new Set(searched.map((m) => m.id));
      // Touch accessed_at for searched memories (same as memory.ts touchMemory)
      for (const m of searched) {
        db.prepare('UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?')
          .run(Math.floor(Date.now() / 1000), m.id);
      }
      // Recent memories — top 5 deduplicated
      const recent = (db.prepare(
        'SELECT id, content, sector FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT 5'
      ).all(gonzaloChatId) as Array<{ content: string; sector: string; id: number }>)
        .filter((m) => !seenIds.has(m.id));
      const lines = [...searched, ...recent].map((m) => `- ${m.content} (${m.sector})`);
      if (lines.length === 0) return '';
      return `[Memory context]\n${lines.join('\n')}\n[End memory context]`;
    } catch { return ''; }
  }

  /**
   * Save a conversation turn to the shared memory pool.
   * Called after every glasses/VAPI-tool interaction so Telegram and phone calls see it.
   * Uses ALLOWED_CHAT_ID as the universal Gonzalo chat_id — same as Telegram bot.
   */
  function saveCrossPlatformConversationTurn(userMessage: string, assistantResponse: string, sessionId?: string): void {
    const gonzaloChatId = process.env['ALLOWED_CHAT_ID'] ?? '';
    if (!gonzaloChatId) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      // Log to conversation_log (same table Telegram uses for /respin)
      db.prepare('INSERT INTO conversation_log (chat_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(gonzaloChatId, sessionId ?? null, 'user', userMessage, now);
      db.prepare('INSERT INTO conversation_log (chat_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(gonzaloChatId, sessionId ?? null, 'assistant', assistantResponse, now);
      // Save user message to memories — same logic as memory.ts saveConversationTurn
      if (userMessage.length > 20 && !userMessage.startsWith('/')) {
        const semanticSignal = /\b(my|i am|i'm|i prefer|remember|always|never|quiero|siempre|nunca|prefiero|recuerda|mi |soy )\b/i;
        const sector = semanticSignal.test(userMessage) ? 'semantic' : 'episodic';
        db.prepare('INSERT INTO memories (chat_id, content, sector, created_at, accessed_at) VALUES (?, ?, ?, ?, ?)')
          .run(gonzaloChatId, userMessage, sector, now, now);
      }
    } catch (err) {
      logger.warn({ err }, '[glasses] Failed to save conversation turn to shared memory');
    }
  }

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const auth = req.headers['authorization'] as string | undefined;
      const token = process.env['DASHBOARD_TOKEN'] || '';
      if (!auth || auth !== `Bearer ${token}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const body = req.body as { messages?: Array<{ role: string; content: string }>; model?: string };
      const messages = body.messages ?? [];
      const lastUser = messages.filter((m) => m.role === 'user').pop();
      if (!lastUser) {
        return res.status(400).json({ error: 'No user message found' });
      }

      logger.info({ content: lastUser.content }, '[glasses/completions] task received');

      // ── Dedicated glasses session: always use chat_id 'glasses-main' ──
      let sessionRow = db.prepare(
        "SELECT session_id, chat_id FROM sessions WHERE chat_id = 'glasses-main' LIMIT 1"
      ).get() as { session_id: string; chat_id: string } | undefined;

      if (!sessionRow) {
        // First-time boot: create a dedicated glasses session
        const newGlassesSessionId = `glasses-${Date.now()}`;
        db.prepare(
          "INSERT INTO sessions (chat_id, session_id, updated_at) VALUES ('glasses-main', ?, datetime('now'))"
        ).run(newGlassesSessionId);
        sessionRow = { session_id: newGlassesSessionId, chat_id: 'glasses-main' };
        logger.info('[glasses/completions] Created new dedicated glasses session: ' + newGlassesSessionId);
      } else {
        logger.info('[glasses/completions] Resuming glasses session: ' + sessionRow.session_id);
      }

      // ── Cross-platform memory sync: read shared memory before calling agent ──
      const memCtx = buildCrossPlatformMemoryContext(lastUser.content);
      const glassesNow = new Date();
      const dateCtx = `[Context: Today is ${glassesNow.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${glassesNow.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}. Source: VisionClaw glasses. Timezone: America/Monterrey (UTC-6).]`;
      const fullMessage = [dateCtx, memCtx, lastUser.content].filter(Boolean).join('\n\n');

      const result = await runAgent(fullMessage, sessionRow?.session_id, () => {});

      if (result.newSessionId && sessionRow) {
        db.prepare("UPDATE sessions SET session_id = ?, updated_at = datetime('now') WHERE chat_id = ?")
          .run(result.newSessionId, sessionRow.chat_id);
      }

      // ── Cross-platform memory sync: write this interaction to shared pool ──
      const responseText = result.text?.trim() ?? 'Done.';
      saveCrossPlatformConversationTurn(lastUser.content, responseText, result.newSessionId ?? sessionRow?.session_id);

      // OpenAI-compatible response format
      res.json({
        id: `glasses-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'thorn',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: responseText },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      logger.error({ err }, '[glasses/completions] error');
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /vapi-tool — Vapi server-side tool webhook
  // Called by Vapi when the glasses assistant triggers an `execute` or `describe_current_view` tool
  app.post('/vapi-tool', async (req: Request, res: Response) => {
    try {
      const body = req.body as {
        message?: {
          toolCalls?: Array<{ id: string; function: { name: string; arguments: Record<string, unknown> } }>;
        };
      };

      const toolCalls = body.message?.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return res.status(400).json({ error: 'No tool calls found' });
      }

      const results: Array<{ toolCallId: string; result: string }> = [];

      for (const call of toolCalls) {
        const name = call.function.name;
        const args = call.function.arguments;
        logger.info({ name, args }, '[vapi-tool] tool call received');

        let result = 'Done.';

        if (name === 'execute') {
          const task = (args['task'] as string) || JSON.stringify(args);
          const sessionRow = db.prepare(
            'SELECT session_id, chat_id FROM sessions ORDER BY updated_at DESC LIMIT 1'
          ).get() as { session_id: string; chat_id: string } | undefined;

          // ── Cross-platform memory sync: inject shared memory before agent call ──
          const vapiToolMemCtx = buildCrossPlatformMemoryContext(task);
          const vapiToolNow = new Date();
          const vapiToolDateCtx = `[Context: Today is ${vapiToolNow.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${vapiToolNow.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}. Source: VAPI phone call tool. Timezone: America/Monterrey (UTC-6).]`;
          const vapiToolFullMessage = [vapiToolDateCtx, vapiToolMemCtx, task].filter(Boolean).join('\n\n');

          const agentResult = await runAgent(vapiToolFullMessage, sessionRow?.session_id, () => {});

          if (agentResult.newSessionId && sessionRow) {
            db.prepare("UPDATE sessions SET session_id = ?, updated_at = datetime('now') WHERE chat_id = ?")
              .run(agentResult.newSessionId, sessionRow.chat_id);
          }
          result = agentResult.text ?? 'Done.';
          // ── Cross-platform memory sync: write task outcome to shared pool ──
          saveCrossPlatformConversationTurn(task, result, agentResult.newSessionId ?? sessionRow?.session_id);
        } else if (name === 'describe_current_view') {
          const imageB64 = args['image'] as string | undefined;
          const context = args['context'] as string | undefined;
          if (imageB64) {
            try {
              // Call Claude vision API directly with the base64 JPEG frame from the glasses
              const anthropicKey = process.env['ANTHROPIC_API_KEY'];
              if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');
              const visionPrompt = context
                ? `You are Thorn, Gonzalo's AI assistant. He is looking at something and asks: "${context}". Describe what you see concisely in 1-2 sentences, focusing on what's relevant to his question.`
                : `You are Thorn, Gonzalo's AI assistant. Describe what you see in this image from his glasses camera. Be concise and specific — 1-2 sentences max.`;
              const visionRes = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                  'x-api-key': anthropicKey,
                  'anthropic-version': '2023-06-01',
                  'content-type': 'application/json',
                },
                body: JSON.stringify({
                  model: 'claude-opus-4-5',
                  max_tokens: 256,
                  messages: [{
                    role: 'user',
                    content: [
                      {
                        type: 'image',
                        source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 },
                      },
                      { type: 'text', text: visionPrompt },
                    ],
                  }],
                }),
              });
              const visionJson = await visionRes.json() as { content?: Array<{ text?: string }> };
              result = visionJson.content?.[0]?.text ?? 'Unable to analyze image.';
              logger.info({ resultLen: result.length }, '[vapi-tool] vision analysis complete');
            } catch (visionErr) {
              logger.error({ visionErr }, '[vapi-tool] vision API error');
              result = 'I could not analyze the image right now. Try again.';
            }
          } else {
            result = 'No image received. Make sure the iOS app sends the frame as args.image (base64 JPEG).';
          }
        }

        results.push({ toolCallId: call.id, result });
      }

      // Vapi tool response format
      res.json({ results });
    } catch (err) {
      logger.error({ err }, '[vapi-tool] error');
      res.status(500).json({ error: String(err) });
    }
  });

  // ── End VisionClaw / Glasses Gateway ─────────────────────────────────

  // ── Business Areas API ────────────────────────────────────────────────

  app.get('/api/business-areas', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare('SELECT * FROM business_areas ORDER BY created_at ASC').all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/business-areas', (req: Request, res: Response) => {
    try {
      const body = req.body as { name?: string; sector?: string; status?: string; color?: string; notes?: string };
      const { name, sector, status, color, notes } = body;
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const VALID_STATUSES = ['exploring', 'active', 'discarded'];
      const safeStatus = status && VALID_STATUSES.includes(status) ? status : 'exploring';
      const id = `ba-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(
        `INSERT INTO business_areas (id, name, sector, status, color, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(id, name.trim(), sector?.trim() || 'Other', safeStatus, color || '#60A5FA', notes?.trim() || null);
      const row = db.prepare('SELECT * FROM business_areas WHERE id = ?').get(id);
      res.status(201).json(row);
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('UNIQUE')) return res.status(409).json({ error: 'A business area with that name already exists' });
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/business-areas/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const body = req.body as { name?: string; sector?: string; status?: string; color?: string; notes?: string };
      const existing = db.prepare('SELECT * FROM business_areas WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const VALID_STATUSES = ['exploring', 'active', 'discarded'];
      const e = existing as { name: string; sector: string; status: string; color: string; notes: string };
      const name = body.name?.trim() || e.name;
      const sector = body.sector?.trim() || e.sector;
      const status = body.status && VALID_STATUSES.includes(body.status) ? body.status : e.status;
      const color = body.color || e.color;
      const notes = body.notes !== undefined ? body.notes?.trim() || null : e.notes;
      db.prepare(
        `UPDATE business_areas SET name=?, sector=?, status=?, color=?, notes=?, updated_at=datetime('now') WHERE id=?`
      ).run(name, sector, status, color, notes, id);
      const row = db.prepare('SELECT * FROM business_areas WHERE id = ?').get(id);
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/business-areas/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const result = db.prepare('DELETE FROM business_areas WHERE id = ?').run(id);
      if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── End Business Areas API ────────────────────────────────────────────

  // ── Finance API ───────────────────────────────────────────────────────

  app.get('/api/finance/transactions', (req: Request, res: Response) => {
    try {
      const area = (req.query as Record<string, string>)['area'];
      const limit = Math.min(Number((req.query as Record<string, string>)['limit']) || 200, 500);
      let query = 'SELECT * FROM financial_transactions';
      const params: SqlBinding[] = [];
      if (area && area !== 'all') {
        query += ' WHERE area = ?';
        params.push(area);
      }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      const rows = db.prepare(query).all(...params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/finance/transactions', (req: Request, res: Response) => {
    try {
      const body = req.body as { amount?: number; type?: string; area?: string; notes?: string; created_at?: string };
      const { amount, type, area, notes, created_at } = body;
      if (typeof amount !== 'number' || !type || !area) {
        return res.status(400).json({ error: 'amount (number), type, and area are required' });
      }
      if (!['income', 'expense'].includes(type)) {
        return res.status(400).json({ error: 'type must be income or expense' });
      }
      const VALID_AREAS = [
        'AI Sales',
        'Crypto Trading',
        'Stock Trading',
        'AI Content Agency',
        'Automation Consulting',
        'Micro-SaaS Tools',
        'Affiliate Revenue',
        'Prompt Engineering',
        'Newsletter',
        'Domain Flipping',
        'Other',
      ];
      if (!VALID_AREAS.includes(area)) {
        return res.status(400).json({ error: `area must be one of: ${VALID_AREAS.join(', ')}` });
      }
      const id = `ft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = created_at || new Date().toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(
        `INSERT INTO financial_transactions (id, amount, type, area, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, amount, type, area, notes || null, createdAt);
      const row = db.prepare('SELECT * FROM financial_transactions WHERE id = ?').get(id);
      // Push SSE so Revenue dashboard updates in real time
      const pushFnFt = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
      if (pushFnFt) pushFnFt(`data: ${JSON.stringify({ type: 'finance', action: 'created', row })}\n\n`);
      res.status(201).json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/finance/transactions/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params as { id: string };
      const result = db.prepare('DELETE FROM financial_transactions WHERE id = ?').run(id);
      if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
      // Push SSE so Revenue dashboard updates in real time
      const pushFnFtDel = (app as unknown as Record<string, unknown>)['_pushSSE'] as ((p: string) => void) | undefined;
      if (pushFnFtDel) pushFnFtDel(`data: ${JSON.stringify({ type: 'finance', action: 'deleted', id })}\n\n`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/finance/summary', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare('SELECT type, area, SUM(amount) as total FROM financial_transactions GROUP BY type, area').all() as Array<{ type: string; area: string; total: number }>;

      const AREAS = [
        'AI Sales', 'Crypto Trading', 'Stock Trading', 'AI Content Agency',
        'Automation Consulting', 'Micro-SaaS Tools', 'Affiliate Revenue',
        'Prompt Engineering', 'Newsletter', 'Domain Flipping', 'Other',
      ];
      const byArea: Record<string, { income: number; expense: number; net: number }> = {};
      for (const a of AREAS) byArea[a] = { income: 0, expense: 0, net: 0 };

      let totalIncome = 0;
      let totalExpense = 0;

      for (const row of rows) {
        if (!byArea[row.area]) byArea[row.area] = { income: 0, expense: 0, net: 0 };
        if (row.type === 'income') {
          byArea[row.area].income += row.total;
          totalIncome += row.total;
        } else if (row.type === 'expense') {
          byArea[row.area].expense += row.total;
          totalExpense += row.total;
        }
      }

      for (const a of Object.keys(byArea)) {
        byArea[a].net = byArea[a].income - byArea[a].expense;
      }

      // Pull LLM costs from token_usage (real AI API spend)
      let llmCostTotal = 0;
      try {
        const llmRow = db.prepare('SELECT SUM(cost_usd) as total FROM token_usage').get() as { total: number | null };
        llmCostTotal = llmRow?.total ?? 0;
      } catch { /* ignore if table missing */ }

      // Agent activity stats
      let tasksCompleted = 0;
      let agentsActive = 0;
      try {
        const tasksRow = db.prepare("SELECT COUNT(*) as cnt FROM agent_tasks WHERE status='done'").get() as { cnt: number };
        tasksCompleted = tasksRow?.cnt ?? 0;
        const agentsRow = db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status='active' OR status='working'").get() as { cnt: number };
        agentsActive = agentsRow?.cnt ?? 0;
      } catch { /* ignore */ }

      // Today's P&L
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayRows = db.prepare(
        `SELECT type, SUM(amount) as total FROM financial_transactions WHERE created_at >= ? GROUP BY type`
      ).all(`${todayStr} 00:00:00`) as Array<{ type: string; total: number }>;

      let todayIncome = 0;
      let todayExpense = 0;
      for (const r of todayRows) {
        if (r.type === 'income') todayIncome += r.total;
        else if (r.type === 'expense') todayExpense += r.total;
      }

      res.json({
        total_income: totalIncome,
        total_expense: totalExpense,
        net_pl: totalIncome - totalExpense,
        total_capital: totalIncome - totalExpense,
        today_income: todayIncome,
        today_expense: todayExpense,
        today_pl: todayIncome - todayExpense,
        by_area: byArea,
        llm_cost_usd: llmCostTotal,
        tasks_completed: tasksCompleted,
        agents_active: agentsActive,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── End Finance API ───────────────────────────────────────────────────

  // ── Revenue API (live data: Binance balance + revenue events) ────────

  // Ensure revenue_events table exists
  db.exec(`CREATE TABLE IF NOT EXISTS revenue_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    description TEXT,
    amount_usd REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // GET /api/revenue/summary — totals from financial_transactions + event count
  app.get('/api/revenue/summary', (_req: Request, res: Response) => {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const monthStr = new Date().toISOString().slice(0, 7);

      const allRows = db.prepare(
        "SELECT type, SUM(amount) as total FROM financial_transactions GROUP BY type"
      ).all() as Array<{ type: string; total: number }>;

      let totalIncome = 0;
      let totalExpense = 0;
      for (const r of allRows) {
        if (r.type === 'income') totalIncome += r.total;
        else if (r.type === 'expense') totalExpense += r.total;
      }

      const monthRows = db.prepare(
        "SELECT type, SUM(amount) as total FROM financial_transactions WHERE created_at >= ? GROUP BY type"
      ).all(`${monthStr}-01 00:00:00`) as Array<{ type: string; total: number }>;

      let monthIncome = 0;
      let monthExpense = 0;
      for (const r of monthRows) {
        if (r.type === 'income') monthIncome += r.total;
        else if (r.type === 'expense') monthExpense += r.total;
      }

      const todayRows = db.prepare(
        "SELECT type, SUM(amount) as total FROM financial_transactions WHERE created_at >= ? GROUP BY type"
      ).all(`${todayStr} 00:00:00`) as Array<{ type: string; total: number }>;

      let todayIncome = 0;
      let todayExpense = 0;
      for (const r of todayRows) {
        if (r.type === 'income') todayIncome += r.total;
        else if (r.type === 'expense') todayExpense += r.total;
      }

      const activeEventsRow = db.prepare(
        "SELECT COUNT(*) as cnt FROM revenue_events WHERE status = 'active'"
      ).get() as { cnt: number };

      const recentEvents = db.prepare(
        "SELECT * FROM revenue_events ORDER BY created_at DESC LIMIT 10"
      ).all();

      res.json({
        today: { income: todayIncome, expense: todayExpense, net: todayIncome - todayExpense },
        month: { income: monthIncome, expense: monthExpense, net: monthIncome - monthExpense },
        all_time: { income: totalIncome, expense: totalExpense, net: totalIncome - totalExpense },
        active_operations: activeEventsRow.cnt,
        recent_events: recentEvents,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/revenue/binance-balance — live Binance spot wallet value in USD
  // 1) Tries Binance API directly (HMAC signed) for real full account balance
  // 2) Falls back to multi-trader status.json + binance-bot status.json
  app.get('/api/revenue/binance-balance', async (_req: Request, res: Response) => {
    try {
      const MULTI_STATUS = '/Users/opoclaw1/claudeclaw/opo-work/multi-trader/status.json';
      const DCA_STATUS   = '/Users/opoclaw1/claudeclaw/opo-work/binance-bot/pm2-out.log';

      const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);
      let balances: Record<string, number> = {};
      let botUpdatedAt: string | null = null;
      let source = 'bot_state';

      // ── Attempt 1: call Binance /api/v3/account directly (HMAC signed) ──
      const BINANCE_KEY = process.env.BINANCE_API_KEY ?? '';
      const BINANCE_SECRET = process.env.BINANCE_SECRET_KEY ?? '';
      if (BINANCE_KEY && BINANCE_SECRET) {
        try {
          
          const timestamp = Date.now();
          const queryString = `timestamp=${timestamp}`;
          const signature = createHmac('sha256', BINANCE_SECRET).update(queryString).digest('hex');
          const accountRes = await fetch(
            `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
            { headers: { 'X-MBX-APIKEY': BINANCE_KEY }, signal: AbortSignal.timeout(8000) }
          );
          if (accountRes.ok) {
            const accountData = await accountRes.json() as { balances?: Array<{ asset: string; free: string; locked: string }> };
            if (accountData.balances) {
              for (const b of accountData.balances) {
                const total = parseFloat(b.free) + parseFloat(b.locked);
                if (total > 0.000001) balances[b.asset] = total;
              }
              botUpdatedAt = new Date().toISOString();
              source = 'binance_api';
            }
          }
        } catch { /* fall through to file fallback */ }
      }

      // ── Attempt 2: read from multi-trader status.json + all bot positions.json files ──
      if (source !== 'binance_api') {
        // USDT from multi-trader status
        try {
          const multiRaw = fs.readFileSync(MULTI_STATUS, 'utf-8');
          const multiStatus = JSON.parse(multiRaw) as {
            usdt?: number;
            updatedAt?: string;
            positions?: Record<string, { qty: number }>;
          };
          if (typeof multiStatus.usdt === 'number') {
            balances['USDT'] = (balances['USDT'] ?? 0) + multiStatus.usdt;
          }
          botUpdatedAt = multiStatus.updatedAt ?? null;
        } catch { /* no multi-trader state */ }

        // Positions from each bot's positions.json (source of truth for held coins)
        const positionFiles = [
          '/Users/opoclaw1/claudeclaw/opo-work/multi-trader/positions.json',
          '/Users/opoclaw1/claudeclaw/opo-work/binance-bot/positions.json',
        ];
        for (const posFile of positionFiles) {
          try {
            const posData = JSON.parse(fs.readFileSync(posFile, 'utf-8')) as Record<string, { qty: number }>;
            for (const [pair, pos] of Object.entries(posData)) {
              const coin = pair.split('/')[0];
              if (coin && pos.qty > 0) {
                balances[coin] = (balances[coin] ?? 0) + pos.qty;
              }
            }
          } catch { /* file missing or empty */ }
        }
      }

      // ── Price resolution ──
      let totalUSD = 0;
      const assetResults: Array<{ asset: string; amount: number; value_usd: number }> = [];

      for (const [asset, amount] of Object.entries(balances)) {
        if (amount <= 0) continue;
        if (STABLE.has(asset)) {
          totalUSD += amount;
          assetResults.push({ asset, amount, value_usd: amount });
          continue;
        }
        let priceUSD = 0;
        for (const pair of [`${asset}USDT`, `${asset}USDC`]) {
          try {
            const priceRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, {
              signal: AbortSignal.timeout(5000),
            });
            if (priceRes.ok) {
              const priceData = await priceRes.json() as { price?: string };
              priceUSD = parseFloat(priceData.price ?? '0');
              break;
            }
          } catch { /* try next */ }
        }
        const valueUSD = amount * priceUSD;
        totalUSD += valueUSD;
        if (valueUSD > 0.001) {
          assetResults.push({ asset, amount, value_usd: valueUSD });
        }
      }

      const responseData = {
        total_usd: Math.round(totalUSD * 100) / 100,
        fallback: false,
        assets: assetResults.sort((a, b) => b.value_usd - a.value_usd),
        fetched_at: botUpdatedAt ?? new Date().toISOString(),
        source,
      };

      if (totalUSD === 0 && assetResults.length === 0) {
        // No live data — serve last cached balance instead of zeros
        try {
          const cached = db.prepare(`SELECT data, updated_at FROM dashboard_cache WHERE key='binance_balance'`).get() as any;
          if (cached) {
            const cachedData = JSON.parse(cached.data);
            cachedData._stale = true;
            cachedData._cachedAt = cached.updated_at;
            return res.json(cachedData);
          }
        } catch {}
        return res.json({ total_usd: 0, fallback: true, reason: 'no_data', assets: [], fetched_at: new Date().toISOString() });
      }

      // Cache the good response
      try {
        db.prepare(`INSERT OR REPLACE INTO dashboard_cache (key, data, updated_at)
          VALUES ('binance_balance', ?, datetime('now'))`).run(JSON.stringify(responseData));
      } catch {}

      res.json(responseData);
    } catch (err) {
      // On exception, serve cache instead of error
      try {
        const cached = db.prepare(`SELECT data, updated_at FROM dashboard_cache WHERE key='binance_balance'`).get() as any;
        if (cached) {
          const cachedData = JSON.parse(cached.data);
          cachedData._stale = true;
          cachedData._cachedAt = cached.updated_at;
          return res.json(cachedData);
        }
      } catch {}
      res.status(200).json({ total_usd: 0, fallback: true, reason: String(err), assets: [] });
    }
  });

  // GET /api/revenue/trading-status — full trading bot state for Revenue page
  app.get('/api/revenue/trading-status', async (_req: Request, res: Response) => {
    try {
      const MULTI_STATUS = '/Users/opoclaw1/claudeclaw/opo-work/multi-trader/status.json';
      const DCA_LOG      = '/Users/opoclaw1/claudeclaw/opo-work/binance-bot/pm2-out.log';

      let multiStatus: Record<string, unknown> = {};
      let dcaRecentLines: string[] = [];

      try { multiStatus = JSON.parse(fs.readFileSync(MULTI_STATUS, 'utf-8')); } catch { /* ok */ }

      // Parse last 10 meaningful lines from DCA bot log
      try {
        const lines = fs.readFileSync(DCA_LOG, 'utf-8').trim().split('\n').filter(Boolean);
        dcaRecentLines = lines.slice(-20).reverse().slice(0, 10);
      } catch { /* ok */ }

      // Parse recent trades from multi-trader status
      const recentTrades = Array.isArray((multiStatus as { trades?: unknown[] }).trades)
        ? (multiStatus as { trades: unknown[] }).trades.slice(-10).reverse()
        : [];

      // Fetch real PM2 status for the two trading bots
      const BOT_NAMES = ['satoshi-bot', 'nakamoto-bot'];
      const pm2Status: Record<string, { online: boolean; uptime?: number; restarts?: number }> = {};
      try {
        const pm2Env = { ...process.env, HOME: '/Users/opoclaw1', PM2_HOME: '/Users/opoclaw1/.pm2', PATH: '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
        const raw = execSyncShell('/opt/homebrew/bin/pm2 jlist', { encoding: 'utf-8', timeout: 8000, env: pm2Env });
        // pm2 jlist may include log lines before the JSON — strip non-JSON prefix
        const jsonStart = raw.indexOf('[');
        const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
        const list = JSON.parse(jsonStr) as Array<{ name: string; pm2_env: { status: string; pm_uptime?: number; restart_time?: number } }>;
        for (const name of BOT_NAMES) {
          const proc = list.find((p) => p.name === name);
          pm2Status[name] = {
            online: proc?.pm2_env?.status === 'online',
            uptime: proc?.pm2_env?.pm_uptime,
            restarts: proc?.pm2_env?.restart_time,
          };
        }
      } catch (e) {
        // Log error for debugging, mark offline
        console.error('[pm2-status] Failed to get PM2 status:', (e as Error).message);
        for (const name of BOT_NAMES) {
          pm2Status[name] = { online: false };
        }
      }

      res.json({
        multi_trader: multiStatus,
        dca_bot: { recent_log: dcaRecentLines },
        recent_trades: recentTrades,
        pm2_bots: pm2Status,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/binance/account — full Binance wallet via HMAC-signed API call
  // Filters dust (< $0.01 USD), returns total_usd + per-asset breakdown
  app.get('/api/binance/account', async (_req: Request, res: Response) => {
    try {
      const BINANCE_KEY    = process.env.BINANCE_API_KEY ?? '';
      const BINANCE_SECRET = process.env.BINANCE_SECRET_KEY ?? '';

      if (!BINANCE_KEY || !BINANCE_SECRET) {
        return res.status(503).json({ error: 'Binance API keys not configured' });
      }

      const timestamp   = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature   = createHmac('sha256', BINANCE_SECRET).update(queryString).digest('hex');

      const accountRes = await fetch(
        `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
        { headers: { 'X-MBX-APIKEY': BINANCE_KEY }, signal: AbortSignal.timeout(8000) }
      );

      if (!accountRes.ok) {
        const errText = await accountRes.text();
        return res.status(accountRes.status).json({ error: `Binance API error: ${errText}` });
      }

      const accountData = await accountRes.json() as {
        balances: Array<{ asset: string; free: string; locked: string }>;
      };

      const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);

      // Filter dust (zero or near-zero)
      const nonDust = accountData.balances.filter(b => parseFloat(b.free) + parseFloat(b.locked) > 0.000001);

      // Fetch prices in parallel for non-stablecoins
      const pricePromises = nonDust.map(async (b) => {
        const total = parseFloat(b.free) + parseFloat(b.locked);
        if (STABLE.has(b.asset)) return { asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked), total, value_usd: total };

        let priceUSD = 0;
        for (const pair of [`${b.asset}USDT`, `${b.asset}USDC`]) {
          try {
            const priceRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, {
              signal: AbortSignal.timeout(5000),
            });
            if (priceRes.ok) {
              const priceData = await priceRes.json() as { price?: string };
              priceUSD = parseFloat(priceData.price ?? '0');
              break;
            }
          } catch { /* try next */ }
        }
        return { asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked), total, value_usd: total * priceUSD };
      });

      const assets = (await Promise.all(pricePromises))
        .filter(a => a.value_usd >= 0.01)                          // filter dust by USD value
        .sort((a, b) => b.value_usd - a.value_usd);

      const total_usd = Math.round(assets.reduce((sum, a) => sum + a.value_usd, 0) * 100) / 100;

      res.json({ total_usd, assets, updated_at: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/trading/live — live multi-trader state + recent trading activity
  app.get('/api/trading/live', (_req: Request, res: Response) => {
    try {
      const MULTI_STATUS = '/Users/opoclaw1/claudeclaw/opo-work/multi-trader/status.json';
      const DCA_STATUS   = '/Users/opoclaw1/claudeclaw/opo-work/binance-bot/pm2-out.log';

      let multiStatus: Record<string, unknown> = {};
      try { multiStatus = JSON.parse(fs.readFileSync(MULTI_STATUS, 'utf-8')); } catch {}

      // Parse last DCA trade from log
      let dcaLastTrade: string | null = null;
      try {
        const lines = fs.readFileSync(DCA_STATUS, 'utf-8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].includes('[SUCCESS]')) { dcaLastTrade = lines[i]; break; }
        }
      } catch {}

      const recentActivity = db.prepare(
        "SELECT agent_id, agent_name, action, type, created_at FROM agent_activity WHERE department='trading' ORDER BY created_at DESC LIMIT 10"
      ).all();

      res.json({ multi_trader: multiStatus, dca_last_trade: dcaLastTrade, recent_activity: recentActivity });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/trading-activity — trading activity from all bots (opo-trader, opo-multi-trader, etc.)
  app.get('/api/trading-activity', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare(
        "SELECT agent_id, agent_name, action, type, created_at FROM agent_activity WHERE agent_id IN ('opo-trader', 'opo-multi-trader', 'opo-grid-bot', 'trading-bot') OR department = 'trading' ORDER BY created_at DESC LIMIT 30"
      ).all();
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/revenue/live-feed — recent revenue events (polling-friendly)
  app.get('/api/revenue/live-feed', (_req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(((_req as Request).query as Record<string, string>).limit) || 20, 50);
      const events = db.prepare(
        "SELECT * FROM revenue_events ORDER BY created_at DESC LIMIT ?"
      ).all(limit);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/revenue/events — insert a new revenue event
  app.post('/api/revenue/events', (req: Request, res: Response) => {
    try {
      const body = req.body as { source?: string; description?: string; amount_usd?: number; status?: string };
      const { source, description, amount_usd = 0, status = 'pending' } = body;
      if (!source || !description) {
        return res.status(400).json({ error: 'source and description required' });
      }
      const result = db.prepare(
        "INSERT INTO revenue_events (source, description, amount_usd, status) VALUES (?, ?, ?, ?)"
      ).run(source, description, amount_usd, status);
      const row = db.prepare("SELECT * FROM revenue_events WHERE id = ?").get(result.lastInsertRowid);
      res.status(201).json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── End Revenue API ───────────────────────────────────────────────────

  // ── OppoWork API ──────────────────────────────────────────────────────

  app.get('/api/oppowork/balance', (_req: Request, res: Response) => {
    try {
      const row = db.prepare(
        'SELECT balance_usd, total_earned_usd, total_spent_usd, tasks_completed, tasks_failed, survival_status FROM oppowork_balances WHERE client_id = ?'
      ).get('gonzalo') as { balance_usd: number; total_earned_usd: number; total_spent_usd: number; tasks_completed: number; tasks_failed: number; survival_status: string } | undefined;
      if (!row) {
        return res.json({ balance_usd: 1000.0, total_earned_usd: 0, total_spent_usd: 0, tasks_completed: 0, tasks_failed: 0, survival_status: 'thriving' });
      }
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/oppowork/tasks', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt((req.query as Record<string, string>).limit ?? '20', 10), 100);
      const rows = db.prepare(
        'SELECT id, occupation, task_text, quality_score, payment_usd, token_cost_usd, net_profit_usd, status, survival_status, created_at FROM oppowork_tasks ORDER BY created_at DESC LIMIT ?'
      ).all(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/oppowork/stats', (_req: Request, res: Response) => {
    try {
      const balance = db.prepare(
        'SELECT balance_usd, total_earned_usd, total_spent_usd, tasks_completed, tasks_failed FROM oppowork_balances WHERE client_id = ?'
      ).get('gonzalo') as { balance_usd: number; total_earned_usd: number; total_spent_usd: number; tasks_completed: number; tasks_failed: number } | undefined;

      const occupationStats = db.prepare(
        "SELECT occupation, COUNT(*) as count, AVG(quality_score) as avg_score, SUM(net_profit_usd) as net_profit FROM oppowork_tasks WHERE status = 'completed' GROUP BY occupation ORDER BY count DESC"
      ).all();

      res.json({
        balance: balance ?? { balance_usd: 1000.0, total_earned_usd: 0, total_spent_usd: 0, tasks_completed: 0, tasks_failed: 0 },
        by_occupation: occupationStats,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── End OppoWork API ──────────────────────────────────────────────────

  // ── Trading Bot Status API ─────────────────────────────────────────────

  app.get('/api/trading/status', (_req: Request, res: Response) => {
    const statusFile = '/Users/opoclaw1/claudeclaw/trading-bot/logs/status.json';
    const logsFile   = '/Users/opoclaw1/claudeclaw/trading-bot/logs/trades.log';
    try {
      let status: Record<string, unknown> = { status: 'unknown' };
      if (fs.existsSync(statusFile)) {
        status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      }
      let recentLogs: string[] = [];
      if (fs.existsSync(logsFile)) {
        const raw = fs.readFileSync(logsFile, 'utf8');
        recentLogs = raw.split('\n').filter(Boolean).slice(-20);
      }
      res.json({ ...status, recentLogs });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/trading/pm2-status — returns PM2 online status for trading bots
  app.get('/api/trading/pm2-status', (_req: Request, res: Response) => {
    try {
      const pm2Env2 = { ...process.env, HOME: '/Users/opoclaw1', PM2_HOME: '/Users/opoclaw1/.pm2', PATH: '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
      const raw = execSyncShell('/opt/homebrew/bin/pm2 jlist', { encoding: 'utf-8', timeout: 8000, env: pm2Env2 });
      const jsonStart2 = raw.indexOf('[');
      const jsonStr2 = jsonStart2 >= 0 ? raw.slice(jsonStart2) : raw;
      const list = JSON.parse(jsonStr2) as Array<{ name: string; pm2_env: { status: string; pm_uptime?: number; restart_time?: number } }>;
      const bots = ['satoshi-bot', 'nakamoto-bot'];
      const result: Record<string, { online: boolean; uptime?: number; restarts?: number }> = {};
      for (const name of bots) {
        const proc = list.find(p => p.name === name);
        result[name] = {
          online: proc?.pm2_env?.status === 'online',
          uptime: proc?.pm2_env?.pm_uptime,
          restarts: proc?.pm2_env?.restart_time,
        };
      }
      res.json(result);
    } catch (err) {
      console.error('[pm2-status-endpoint] Failed to get PM2 status:', String(err));
      // Fallback: mark offline if PM2 is unavailable
      res.json({
        'satoshi-bot':   { online: false },
        'nakamoto-bot':  { online: false },
      });
    }
  });

  // GET /api/trading/bots — aggregates Freqtrade bot status from both instances
  app.get('/api/trading/bots', async (_req: Request, res: Response) => {
    // Read actual pair_whitelist from each bot's config.json (no hardcoding)
    const readBotPairs = (configPath: string): string => {
      try {
        const cfg = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
        const whitelist: string[] = cfg?.exchange?.pair_whitelist ?? cfg?.pair_whitelist ?? [];
        return whitelist.length ? whitelist.map((p: string) => p.replace('/USDT','')).join('/') : '—';
      } catch { return '—'; }
    };

    const BASE_FT = '/Users/opoclaw1/claudeclaw/opo-work/freqtrade';
    const BOTS = [
      { name: 'Satoshi', id: 'satoshi-bot', emoji: '₿', port: 8081, user: 'satoshi', pass: 'opoclaw2026', pairs: readBotPairs(`${BASE_FT}/satoshi/config.json`) },
      { name: 'Nakamoto', id: 'nakamoto-bot', emoji: '🌊', port: 8082, user: 'nakamoto', pass: 'opoclaw2026', pairs: readBotPairs(`${BASE_FT}/nakamoto/config.json`) },
    ];

    const results = await Promise.all(BOTS.map(async (bot) => {
      try {
        const auth = Buffer.from(`${bot.user}:${bot.pass}`).toString('base64');
        const headers = { 'Authorization': `Basic ${auth}` };
        const signal = AbortSignal.timeout(4000);

        const [statusRes, profitRes] = await Promise.all([
          fetch(`http://127.0.0.1:${bot.port}/api/v1/status`, { headers, signal }).then(r => r.json()) as Promise<any[]>,
          fetch(`http://127.0.0.1:${bot.port}/api/v1/profit`, { headers, signal }).then(r => r.json()) as Promise<any>,
        ]);

        const openTrades = Array.isArray(statusRes) ? statusRes : [];
        return {
          id: bot.id,
          name: bot.name,
          emoji: bot.emoji,
          pairs: bot.pairs,
          online: true,
          openTrades: openTrades.length,
          trades: openTrades.map((t: any) => ({
            pair: t.pair,
            profitPct: parseFloat((t.profit_pct ?? 0).toFixed(2)),
            profitAbs: parseFloat((t.profit_abs ?? 0).toFixed(4)),
            openRate: t.open_rate,
            currentRate: t.current_rate,
            stake: t.stake_amount,
          })),
          totalProfit: parseFloat((profitRes.profit_all_coin ?? 0).toFixed(4)),
          tradeCount: profitRes.trade_count ?? 0,
          winRate: profitRes.trade_count > 0
            ? parseFloat(((profitRes.winning_trades / profitRes.trade_count) * 100).toFixed(1))
            : null,
        };
      } catch {
        return { id: bot.id, name: bot.name, emoji: bot.emoji, pairs: bot.pairs, online: false, openTrades: 0, trades: [], totalProfit: 0, tradeCount: 0, winRate: null };
      }
    }));

    // If at least one bot is online, cache the result as last known good data
    const anyOnline = results.some((r: any) => r.online);
    if (anyOnline) {
      try {
        db.prepare(`INSERT OR REPLACE INTO dashboard_cache (key, data, updated_at)
          VALUES ('trading_bots', ?, datetime('now'))`).run(JSON.stringify(results));
      } catch {}
    }

    // If ALL bots are offline (e.g. restarting), serve last cached data with a stale flag
    if (!anyOnline) {
      try {
        const cached = db.prepare(`SELECT data, updated_at FROM dashboard_cache WHERE key='trading_bots'`).get() as any;
        if (cached) {
          const cachedData = JSON.parse(cached.data);
          cachedData.forEach((b: any) => { b._stale = true; b._cachedAt = cached.updated_at; });
          return res.json(cachedData);
        }
      } catch {}
    }

    res.json(results);
  });

  // ── End Trading Bot Status API ─────────────────────────────────────────

  // ── Clients API (SQLite-backed) ───────────────────────────────────────────────

  app.get('/api/clients', (_req: Request, res: Response) => {
    try {
      const rows = db.prepare(`
        SELECT id, name, contact_name, email, company, channel, service, status, pipeline_stage,
               amount_paid, notes, assigned_agent, outreach_sent_at, replied_at, last_contact_at,
               created_at, updated_at
        FROM clients ORDER BY created_at DESC
      `).all();
      res.json(rows);
    } catch { res.json([]); }
  });

  app.post('/api/clients', (req: Request, res: Response) => {
    try {
      const b = req.body as Record<string, string | number | null>;
      const id = `client-${Date.now()}`;
      const status = (b['status'] as string) ?? 'prospect';
      const pipelineStage = (b['pipeline_stage'] as string) ?? status;
      db.prepare(`
        INSERT INTO clients (id, name, contact_name, email, company, channel, service, status,
          pipeline_stage, amount_paid, notes, assigned_agent, outreach_sent_at, replied_at,
          last_contact_at, created_at, updated_at)
        VALUES (@id,@name,@contact_name,@email,@company,@channel,@service,@status,
          @pipeline_stage,@amount_paid,@notes,@assigned_agent,@outreach_sent_at,@replied_at,
          @last_contact_at,datetime('now'),datetime('now'))
      `).run({
        id, name: b['name'] ?? '', contact_name: b['contact_name'] ?? null,
        email: b['email'] ?? null, company: b['company'] ?? null,
        channel: b['channel'] ?? 'ai-service', service: b['service'] ?? null,
        status, pipeline_stage: pipelineStage, amount_paid: b['amount_paid'] ?? 0,
        notes: b['notes'] ?? null, assigned_agent: b['assigned_agent'] ?? null,
        outreach_sent_at: b['outreach_sent_at'] ?? null, replied_at: b['replied_at'] ?? null,
        last_contact_at: b['last_contact_at'] ?? null,
      });
      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
      res.json(client);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.patch('/api/clients/:id', (req: Request, res: Response) => {
    try {
      const clientPatchId = String(req.params['id'] ?? '');
      const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientPatchId) as Record<string, unknown> | undefined;
      if (!existing) return res.status(404).json({ error: 'not found' });
      const b = req.body as Record<string, string | number | null>;
      const allowedFields = ['name','contact_name','email','company','channel','service','status',
        'pipeline_stage','amount_paid','notes','assigned_agent','outreach_sent_at','replied_at','last_contact_at'];
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: Record<string, string | number | null> = { id: clientPatchId };
      for (const field of allowedFields) {
        if (field in b) { sets.push(`${field} = @${field}`); params[field] = b[field] ?? null; }
      }
      db.prepare(`UPDATE clients SET ${sets.join(', ')} WHERE id = @id`).run(params);
      const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientPatchId);
      res.json(updated);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.delete('/api/clients/:id', (req: Request, res: Response) => {
    try {
      const clientDelId = String(req.params['id'] ?? '');
      const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientDelId);
      if (!existing) return res.status(404).json({ error: 'not found' });
      db.prepare('DELETE FROM clients WHERE id = ?').run(clientDelId);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post('/api/clients/:id/deliver', (deliverReq: Request, res: Response) => {
    try {
      const clientId = deliverReq.params['id'] as string;
      const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as Record<string, unknown> | undefined;
      if (!existing) return res.status(404).json({ error: 'not found' });
      db.prepare(`UPDATE clients SET status = 'completed', pipeline_stage = 'completed', updated_at = datetime('now') WHERE id = ?`).run(clientId);
      db.prepare("INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").run(
        'thorn','Thorn','🌵',`Entregable enviado a cliente: ${existing['name']} — ${existing['service'] ?? ''}`, 'success','executive'
      );
      const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
      res.json(updated);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/clients/stats', (_req: Request, res: Response) => {
    try {
      const total = (db.prepare('SELECT COUNT(*) as cnt FROM clients').get() as { cnt: number }).cnt;
      const replied = (db.prepare(
        `SELECT COUNT(*) as cnt FROM clients WHERE status IN ('replied','call_scheduled','proposal_sent','paid','delivering','completed')`
      ).get() as { cnt: number }).cnt;
      const revenue = (db.prepare('SELECT COALESCE(SUM(amount_paid),0) as rev FROM clients').get() as { rev: number }).rev;
      res.json({
        total,
        replied,
        reply_rate: total > 0 ? Math.round((replied / total) * 100) : 0,
        revenue,
      });
    } catch { res.json({ total: 0, replied: 0, reply_rate: 0, revenue: 0 }); }
  });

  // ── End Clients API ───────────────────────────────────────────────────────────

  app.use(express.static(DIST, {
    maxAge: '1h',
    etag: true,
  }));
  app.use((_req: Request, res: Response) => {
    res.sendFile(path.join(DIST, 'index.html'));
  });

  return app;
}

// ── Exported start function ───────────────────────────────────────────
export function startDashboardServer(): void {
  const db = initDashboardDb();

  // Prune slow_requests older than 30 days
  const pruneSlowRequests = () => {
    try {
      const result = db.prepare(
        "DELETE FROM slow_requests WHERE created_at < datetime('now', '-30 days')"
      ).run();
      if (result.changes > 0) {
        logger.info(`Pruned ${result.changes} old slow request records`);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to prune slow_requests');
    }
  };
  pruneSlowRequests(); // run once on startup
  setInterval(pruneSlowRequests, 24 * 60 * 60 * 1000); // run daily

  // ── Auto-promote queued tasks every 30 seconds (fallback sweep) ───────
  // Ensures queued tasks get promoted even if a PATCH webhook was missed.
  const autoPromoteSweep = () => {
    try {
      const agents = db.prepare(
        `SELECT DISTINCT assignee_id FROM agent_tasks WHERE status = 'queued'`
      ).all() as { assignee_id: string }[];

      for (const { assignee_id } of agents) {
        const inProgressCount = (db.prepare(
          `SELECT COUNT(*) as cnt FROM agent_tasks WHERE assignee_id = ? AND status IN ('in_progress', 'pending')`
        ).get(assignee_id) as { cnt: number }).cnt;

        if (inProgressCount > 0) continue;

        const next = db.prepare(`
          SELECT id, title FROM agent_tasks
          WHERE assignee_id = ? AND status = 'queued'
          ORDER BY
            CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
            created_at ASC
          LIMIT 1
        `).get(assignee_id) as { id: string; title: string } | undefined;

        if (next) {
          db.prepare(
            `UPDATE agent_tasks SET status = 'in_progress', progress = 10, updated_at = datetime('now') WHERE id = ?`
          ).run(next.id);
          db.prepare(
            `INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
             VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`
          ).run(`[Sweep] Auto-promoted queued task for ${assignee_id}: ${next.title}`);
          logger.info(`[auto-promote-sweep] Task ${next.id} promoted queued → in_progress for agent ${assignee_id}`);
        }
      }
    } catch (err) {
      logger.error({ err }, '[auto-promote-sweep] Error during queued task sweep');
    }
  };
  setInterval(autoPromoteSweep, 30_000).unref(); // every 30 seconds, non-blocking

  // ── Task Watchdog: mark stuck in_progress tasks as failed ─────────────
  // Runs every 60 seconds. Any task stuck in_progress with no update for
  // more than TASK_TIMEOUT_MINUTES is considered abandoned and marked failed.
  const TASK_TIMEOUT_MINUTES = 15;
  const taskWatchdog = () => {
    try {
      const stuckTasks = db.prepare(`
        SELECT id, title, assignee_id, assignee_name, assignee_emoji
        FROM agent_tasks
        WHERE status = 'in_progress'
          AND skip_worker = 0
          AND updated_at < datetime('now', ? || ' minutes')
      `).all(`-${TASK_TIMEOUT_MINUTES}`) as Array<{ id: string; title: string; assignee_id: string; assignee_name: string; assignee_emoji?: string }>;

      for (const task of stuckTasks) {
        db.prepare(`
          UPDATE agent_tasks
          SET status = 'failed',
              progress = 0,
              evidence = 'watchdog-timeout: no update for ${TASK_TIMEOUT_MINUTES}+ minutes',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(task.id);

        db.prepare(`
          INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
          VALUES ('thorn', 'Thorn', '🌵', ?, 'warning', 'executive', datetime('now'))
        `).run(`Watchdog: tarea "${task.title}" marcada como fallida — sin actividad por ${TASK_TIMEOUT_MINUTES} minutos`);

        logger.warn(`[task-watchdog] Task ${task.id} ("${task.title}") marked failed — stuck in_progress for >${TASK_TIMEOUT_MINUTES}min`);
      }

      if (stuckTasks.length > 0) {
        // Invalidate cache so dashboard picks up the change immediately
        cacheInvalidate('tasks');
        logger.info(`[task-watchdog] Cleaned up ${stuckTasks.length} stuck task(s)`);
      }
    } catch (err) {
      logger.error({ err }, '[task-watchdog] Error during watchdog sweep');
    }
  };
  setInterval(taskWatchdog, 60_000).unref(); // every 60 seconds, non-blocking

  // ── Auto-sync Gmail every 10 minutes ────────────────────────────────
  const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';

  const getFreshGmailTokenForSync = async (): Promise<string | null> => {
    const row = db.prepare(`SELECT access_token, refresh_token, token_expiry FROM oauth_tokens WHERE provider = 'gmail'`).get() as { access_token: string; refresh_token: string | null; token_expiry: string } | undefined;
    if (!row) return null;
    const expiresAt = new Date(row.token_expiry).getTime();
    if (Date.now() < expiresAt - 120000) return row.access_token;
    if (!row.refresh_token) return null;
    const clientId = process.env['GOOGLE_CLIENT_ID'] || '';
    const clientSecret = process.env['GOOGLE_CLIENT_SECRET'] || '';
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: row.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
    });
    const data = await refreshRes.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
    db.prepare(`UPDATE oauth_tokens SET access_token = ?, token_expiry = ?, updated_at = datetime('now') WHERE provider = 'gmail'`).run(data.access_token, newExpiry);
    return data.access_token;
  };

  const autoSyncGmail = async () => {
    try {
      const stored = db.prepare(
        `SELECT access_token, token_expiry, account_email FROM oauth_tokens WHERE provider = 'gmail'`
      ).get() as { access_token: string; token_expiry: string | null; account_email: string | null } | undefined;

      if (!stored?.account_email) {
        logger.debug('[inbox-autosync] No Gmail token stored, skipping');
        return;
      }

      const token = await getFreshGmailTokenForSync();
      if (!token) {
        logger.debug('[inbox-autosync] Gmail token expired and no refresh token, skipping (re-auth needed)');
        return;
      }
      const accountEmail = stored.account_email;

      logger.info('[inbox-autosync] Starting auto-sync for ' + accountEmail);

      // Fetch up to 50 recent inbox messages
      const listRes = await fetch(`${GMAIL_API_BASE}/messages?maxResults=50&q=in:inbox`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (listRes.status === 401) {
        logger.warn('[inbox-autosync] Token rejected (401). Marking expired.');
        db.prepare(`UPDATE oauth_tokens SET token_expiry = datetime('now') WHERE provider = 'gmail'`).run();
        return;
      }
      if (!listRes.ok) {
        logger.error(`[inbox-autosync] Gmail list failed: ${listRes.status}`);
        return;
      }

      const listData = await listRes.json() as { messages?: { id: string }[] };
      const messageIds = listData.messages ?? [];
      if (messageIds.length === 0) {
        logger.debug('[inbox-autosync] No messages found');
        db.prepare(`UPDATE oauth_tokens SET last_sync_at = datetime('now') WHERE provider = 'gmail'`).run();
        return;
      }

      const extractBody = (part: any): string => {
        if (!part) return '';
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        }
        if (part.parts) {
          for (const p of part.parts) {
            const text = extractBody(p);
            if (text) return text;
          }
        }
        return '';
      };

      // Fetch details for each message
      const upsert = db.prepare(`
        INSERT INTO inbox_messages (id, gmail_id, subject, sender, from_email, body_snippet, body_full, starred, read_msg, timestamp, account_email, synced_at)
        VALUES (@id, @gmail_id, @subject, @sender, @from_email, @body_snippet, @body_full, @starred, @read_msg, @timestamp, @account_email, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          subject = excluded.subject, sender = excluded.sender, from_email = excluded.from_email,
          body_snippet = excluded.body_snippet, body_full = excluded.body_full,
          starred = excluded.starred, read_msg = excluded.read_msg, thread_id = excluded.thread_id, synced_at = datetime('now')
      `);

      let synced = 0;
      const insertMany = db.transaction((...args: unknown[]) => {
        for (const m of args[0] as any[]) upsert.run(m);
      });

      const rows: any[] = [];
      for (let i = 0; i < Math.min(messageIds.length, 50); i++) {
        try {
          const format = i < 10 ? 'full' : 'metadata';
          const msgRes = await fetch(`${GMAIL_API_BASE}/messages/${messageIds[i].id}?format=${format}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!msgRes.ok) continue;
          const msg: any = await msgRes.json();

          const headers: Record<string, string> = {};
          for (const h of (msg.payload?.headers ?? [])) {
            headers[(h.name as string).toLowerCase()] = h.value;
          }

          const bodyFull = format === 'full' ? extractBody(msg.payload) : '';
          const fromHeader = headers['from'] ?? '';
          const emailMatch = fromHeader.match(/<(.+?)>/);
          const fromEmail = emailMatch ? emailMatch[1] : fromHeader;
          const senderName = emailMatch
            ? fromHeader.replace(/<.+?>/, '').trim().replace(/^"|"$/g, '')
            : fromHeader;

          rows.push({
            id: msg.id,
            gmail_id: msg.id,
            thread_id: msg.threadId ?? null,
            subject: headers['subject'] ?? '(no subject)',
            sender: senderName || fromEmail,
            from_email: fromEmail,
            body_snippet: msg.snippet ?? '',
            body_full: bodyFull,
            starred: (msg.labelIds ?? []).includes('STARRED') ? 1 : 0,
            read_msg: !(msg.labelIds ?? []).includes('UNREAD') ? 1 : 0,
            timestamp: new Date(parseInt(msg.internalDate)).toISOString(),
            account_email: accountEmail,
          });
          synced++;
        } catch { /* skip individual message errors */ }
      }

      if (rows.length > 0) insertMany(rows);

      // Run AI on any unprocessed messages
      const unprocessed = db.prepare(
        `SELECT id, subject, sender, body_snippet, body_full FROM inbox_messages WHERE ai_summary IS NULL AND account_email = ? LIMIT 20`
      ).all(accountEmail) as any[];
      if (unprocessed.length > 0) {
        processInboxAI(db, unprocessed).catch((e: Error) => logger.error({ err: e }, '[inbox-autosync-ai]'));
      }

      db.prepare(`UPDATE oauth_tokens SET last_sync_at = datetime('now') WHERE provider = 'gmail'`).run();
      cacheInvalidate('inbox');
      logger.info(`[inbox-autosync] Synced ${synced} messages, queued AI for ${unprocessed.length}`);

      // Wait for AI to finish, then auto-reply
      if (unprocessed.length > 0) {
        processInboxAI(db, unprocessed).then(() => autoReplyPending()).catch(() => {});
      } else {
        await autoReplyPending();
      }
    } catch (err) {
      logger.error({ err }, '[inbox-autosync] Error during auto-sync');
    }
  };

  // Domains that should never be auto-replied (banks, legal, automated systems)
  const SKIP_AUTOREPLY_DOMAINS = ['noreply', 'no-reply', 'donotreply', 'notifications', 'mailer', 'bounce',
    'paypal.com', 'stripe.com', 'bank', 'wells', 'chase', 'citibank', 'hsbc', 'amazon.com'];

  const autoReplyPending = async () => {
    try {
      const pending = db.prepare(`
        SELECT id, gmail_id, subject, sender, from_email, ai_draft, thread_id
        FROM inbox_messages
        WHERE category = 'to_respond'
          AND has_draft = 1
          AND auto_replied = 0
          AND account_email = 'opoclaw@gmail.com'
          AND ai_draft IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 10
      `).all() as any[];

      if (pending.length === 0) return;

      const token = await getFreshGmailTokenForSync();
      if (!token) return;

      const botToken = process.env['TELEGRAM_BOT_TOKEN'] || '';
      const chatId = process.env['TELEGRAM_CHAT_ID'] || '';

      for (const msg of pending) {
        const fromEmail = msg.from_email || msg.sender;

        // Skip auto-reply to automated/no-reply senders
        const shouldSkip = SKIP_AUTOREPLY_DOMAINS.some(d => fromEmail.toLowerCase().includes(d));
        if (shouldSkip) {
          db.prepare(`UPDATE inbox_messages SET auto_replied = 1 WHERE id = ?`).run(msg.id);
          continue;
        }

        try {
          const subject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`;
          const headers = [
            'From: opoclaw@gmail.com',
            `To: ${fromEmail}`,
            `Subject: ${subject}`,
            'Content-Type: text/plain; charset=utf-8',
            'MIME-Version: 1.0',
          ];
          if (msg.thread_id) headers.push(`In-Reply-To: ${msg.gmail_id}`, `References: ${msg.gmail_id}`);

          const raw = headers.join('\r\n') + '\r\n\r\n' + msg.ai_draft;
          const encoded = Buffer.from(raw).toString('base64url');

          const sendBody: Record<string, string> = { raw: encoded };
          if (msg.thread_id) sendBody['threadId'] = msg.thread_id;

          const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(sendBody),
          });

          if (sendRes.ok) {
            db.prepare(`UPDATE inbox_messages SET auto_replied = 1, category = 'actioned' WHERE id = ?`).run(msg.id);
            db.prepare(`INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
              VALUES ('finn', 'Finn', '📧', ?, 'success', 'operations', datetime('now'))`
            ).run(`Auto-replied to ${fromEmail}: ${msg.subject?.slice(0, 60)}`);
            logger.info(`[auto-reply] Sent reply to ${fromEmail} | subject: ${msg.subject}`);

            // Telegram notification
            if (botToken && chatId) {
              fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: `Reply sent to ${fromEmail}\nSubject: ${msg.subject?.slice(0, 80)}` }),
              }).catch(() => {});
            }
          } else {
            const errData = await sendRes.json().catch(() => ({})) as any;
            logger.warn(`[auto-reply] Failed to send to ${fromEmail}: ${JSON.stringify(errData)}`);
          }
        } catch (e) {
          logger.error({ err: e }, `[auto-reply] Error sending to ${msg.from_email}`);
        }
      }
      cacheInvalidate('inbox');
    } catch (err) {
      logger.error({ err }, '[auto-reply] sweep error');
    }
  };

  // Run auto-reply sweep independently every 5 minutes
  setTimeout(() => {
    autoReplyPending();
    setInterval(autoReplyPending, 5 * 60 * 1000).unref();
  }, 60_000);

  // Run once 30 seconds after startup (give server time to settle), then every 10 minutes
  setTimeout(() => {
    autoSyncGmail();
    setInterval(autoSyncGmail, 10 * 60 * 1000).unref();
  }, 30_000);

  const app = createDashboardApp(db);

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Dashboard API running on http://0.0.0.0:${PORT} (accessible from all interfaces)`);

    // On startup, promote any queued tasks if there are open concurrency slots
    try {
      const STARTUP_LIMIT = 4;
      const inProgressCount = (db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_tasks WHERE status IN ('in_progress', 'pending')`
      ).get() as { cnt: number }).cnt;

      if (inProgressCount < STARTUP_LIMIT) {
        const slots = STARTUP_LIMIT - inProgressCount;
        let promoted = 0;
        for (let i = 0; i < slots; i++) {
          const next = db.prepare(
            `SELECT id, title FROM agent_tasks WHERE status IN ('todo', 'backlog') ORDER BY created_at ASC LIMIT 1`
          ).get() as { id: string; title: string } | undefined;
          if (!next) break;
          db.prepare(
            `UPDATE agent_tasks SET status = 'in_progress', progress = 10, updated_at = datetime('now') WHERE id = ?`
          ).run(next.id);
          db.prepare(
            `INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
             VALUES ('thorn', 'Thorn', '🌵', ?, 'info', 'executive', datetime('now'))`
          ).run(`Auto-promoted task to in_progress on startup: ${next.title}`);
          logger.info(`[task-queue] Startup: promoted task ${next.id} ("${next.title}") to in_progress`);
          promoted++;
        }
        if (promoted > 0) {
          logger.info(`[task-queue] Startup promotion complete: ${promoted} task(s) moved to in_progress`);
        }
      }
    } catch (err) {
      logger.error({ err }, '[task-queue] Startup promotion failed');
    }
  });
}

// ── Standalone entry point ────────────────────────────────────────────
startDashboardServer();
