-- ClaudeClaw Database Schema
-- SQLite. Auto-created on first run via: node -e "import('./dist/db.js').then(m=>m.initDatabase())"
-- This file is the canonical reference. Do not run it directly — use the init command above.

-- ── Core bot tables (src/db.ts) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id          TEXT PRIMARY KEY,
  prompt      TEXT NOT NULL,
  schedule    TEXT NOT NULL,
  next_run    INTEGER NOT NULL,
  last_run    INTEGER,
  last_result TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  chat_id       TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  voice_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  topic_key   TEXT,
  content     TEXT NOT NULL,
  sector      TEXT NOT NULL DEFAULT 'semantic',
  salience    REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL DEFAULT 'telegram',
  created_at  INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_message_map (
  telegram_msg_id INTEGER PRIMARY KEY,
  wa_chat_id      TEXT NOT NULL,
  contact_name    TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_chat_id  TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  body         TEXT NOT NULL,
  timestamp    INTEGER NOT NULL,
  is_from_me   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  session_id  TEXT,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'telegram',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        TEXT NOT NULL,
  session_id     TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  did_compact    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS slack_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  user_name    TEXT NOT NULL,
  body         TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  is_from_me   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- ── Dashboard / agent tables (src/dashboard-server.ts) ──────────────

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  full_name    TEXT NOT NULL,
  title        TEXT NOT NULL,
  department   TEXT NOT NULL,
  role         TEXT NOT NULL,
  emoji        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'idle',
  current_task TEXT,
  reports_to   TEXT,
  model        TEXT,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS agent_activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL DEFAULT 'thorn',
  agent_name  TEXT NOT NULL DEFAULT 'Thorn',
  agent_emoji TEXT NOT NULL DEFAULT '🌵',
  action      TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'info',
  department  TEXT,
  metadata    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  assignee_id     TEXT NOT NULL,
  assignee_name   TEXT NOT NULL,
  assignee_emoji  TEXT DEFAULT '⚙️',
  department      TEXT,
  priority        TEXT NOT NULL DEFAULT 'medium',
  status          TEXT NOT NULL DEFAULT 'todo',
  progress        INTEGER NOT NULL DEFAULT 0,
  delegated_by    TEXT,
  evidence        TEXT,
  retry_after     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id            TEXT PRIMARY KEY,
  action_type   TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  urgency       TEXT NOT NULL DEFAULT 'normal',
  status        TEXT NOT NULL DEFAULT 'pending',
  action_data   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE TABLE IF NOT EXISTS llm_costs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id           TEXT NOT NULL,
  model              TEXT NOT NULL,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS morning_briefs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  title      TEXT NOT NULL,
  script     TEXT,
  audio_path TEXT,
  sections   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brief_sections_config (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sections   TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brief_context (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  content    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  used_at    TEXT,
  status     TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS agent_meetings (
  id                 TEXT PRIMARY KEY,
  topic              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  location           TEXT DEFAULT 'virtual',
  host_present       INTEGER NOT NULL DEFAULT 0,
  is_recording       INTEGER NOT NULL DEFAULT 0,
  recording_duration TEXT,
  start_time         TEXT NOT NULL DEFAULT (datetime('now')),
  end_time           TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  role       TEXT DEFAULT 'participant',
  joined_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meeting_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  agent_name   TEXT NOT NULL,
  content      TEXT NOT NULL,
  message_type TEXT DEFAULT 'message',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meeting_agenda_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  completed   INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meeting_live_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meeting_blind_spots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  description TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'medium',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brain_vault (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'document',
  agent_id       TEXT,
  agent_name     TEXT,
  department     TEXT,
  folder_path    TEXT NOT NULL DEFAULT 'Varios',
  tags           TEXT,
  source_task_id TEXT,
  starred        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brain_folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  parent_path TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brain_files (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'file',
  mimetype   TEXT,
  size       INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS brain_stars (
  path       TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_kpis (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  label      TEXT NOT NULL,
  value      REAL NOT NULL DEFAULT 0,
  target     REAL NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, label)
);

CREATE TABLE IF NOT EXISTS slow_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider      TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  token_expiry  TEXT,
  account_email TEXT,
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  start_time   TEXT NOT NULL,
  end_time     TEXT NOT NULL,
  type         TEXT DEFAULT 'meeting',
  all_day      INTEGER DEFAULT 0,
  source       TEXT DEFAULT 'google',
  external_id  TEXT UNIQUE,
  external_url TEXT,
  agent_id     TEXT,
  metadata     TEXT,
  synced_at    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id            TEXT PRIMARY KEY,
  gmail_id      TEXT UNIQUE,
  subject       TEXT,
  sender        TEXT,
  from_email    TEXT,
  body_snippet  TEXT,
  body_full     TEXT,
  priority      TEXT DEFAULT 'Medium',
  category      TEXT DEFAULT 'work',
  ai_summary    TEXT,
  ai_draft      TEXT,
  starred       INTEGER DEFAULT 0,
  read_msg      INTEGER DEFAULT 0,
  has_draft     INTEGER DEFAULT 0,
  timestamp     TEXT NOT NULL,
  account_email TEXT,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id        TEXT NOT NULL,
  from_agent_id    TEXT NOT NULL,
  from_agent_name  TEXT NOT NULL,
  from_agent_emoji TEXT NOT NULL,
  to_agent_id      TEXT,
  to_agent_name    TEXT,
  message          TEXT NOT NULL,
  message_type     TEXT NOT NULL DEFAULT 'message',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  files      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id                 TEXT PRIMARY KEY,
  vapi_call_id       TEXT UNIQUE,
  to_number          TEXT,
  contact_name       TEXT,
  objective          TEXT,
  status             TEXT DEFAULT 'queued',
  duration_seconds   INTEGER DEFAULT 0,
  transcript         TEXT,
  outcome            TEXT,
  objective_achieved INTEGER DEFAULT 0,
  started_at         TEXT,
  ended_at           TEXT,
  ended_reason       TEXT,
  task_id            TEXT,
  created_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_transcripts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id      TEXT NOT NULL,
  vapi_call_id TEXT NOT NULL,
  role         TEXT NOT NULL,
  text         TEXT NOT NULL,
  is_final     INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expired INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_transactions (
  id         TEXT PRIMARY KEY,
  amount     REAL NOT NULL,
  type       TEXT NOT NULL,
  area       TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_areas (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sector     TEXT NOT NULL DEFAULT 'Other',
  status     TEXT NOT NULL DEFAULT 'exploring',
  color      TEXT NOT NULL DEFAULT '#60A5FA',
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS people (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  relation           TEXT,
  telegram_username  TEXT,
  telegram_chat_id   TEXT,
  email              TEXT,
  phone              TEXT,
  whatsapp           TEXT,
  notes              TEXT,
  created_at         TEXT DEFAULT (datetime('now')),
  updated_at         TEXT DEFAULT (datetime('now'))
);

-- ── Recording / meeting capture tables ──────────────────────────────

CREATE TABLE IF NOT EXISTS recordings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id      TEXT,
  transcript      TEXT,
  minuta          TEXT,
  summary         TEXT,
  duration_secs   INTEGER,
  filename        TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS live_recordings (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT 'Meeting',
  status         TEXT NOT NULL DEFAULT 'recording',
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at       TEXT,
  transcript     TEXT NOT NULL DEFAULT '',
  live_summary   TEXT NOT NULL DEFAULT '',
  live_minutes   TEXT NOT NULL DEFAULT '',
  live_tasks     TEXT NOT NULL DEFAULT '[]',
  participants   TEXT NOT NULL DEFAULT '[]',
  document_path  TEXT,
  meeting_id     TEXT,
  meeting_type   TEXT NOT NULL DEFAULT 'general',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_email_followups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL,
  document_path TEXT NOT NULL,
  asked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  answered     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting_email_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id INTEGER,
  meeting_id   TEXT,
  email        TEXT NOT NULL,
  sent_at      TEXT DEFAULT (datetime('now')),
  status       TEXT DEFAULT 'sent',
  sent_by      TEXT DEFAULT 'auto'
);

CREATE TABLE IF NOT EXISTS agent_chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Revenue / misc tables ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS revenue_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT,
  description TEXT,
  amount_usd  REAL DEFAULT 0,
  currency    TEXT DEFAULT 'USD',
  status      TEXT DEFAULT 'pending',
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Skill proposals (created by propose-skill.sh) ────────────────────

CREATE TABLE IF NOT EXISTS skill_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name  TEXT NOT NULL,
  skill_slug  TEXT UNIQUE NOT NULL,
  description TEXT,
  proposed_by TEXT,
  status      TEXT NOT NULL DEFAULT 'proposed',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Contact message history ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_name     TEXT NOT NULL,
  contact_username TEXT,
  channel          TEXT NOT NULL DEFAULT 'telegram',
  message_text     TEXT NOT NULL,
  sent_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
