# Building Your Agent Team

ClaudeClaw ships with a multi-agent system built in. Instead of one assistant doing everything, you build a company: a CEO assistant that talks to you, directors that own departments, and workers that execute tasks in parallel. All running on your machine, all visible on the dashboard.

This guide walks you through how it works and how to make it yours.

---

## How the agent system works

### The three layers

**1. Thorn (your personal assistant)**

Thorn is the agent that talks to you directly on Telegram. It's defined in `CLAUDE.md` — that's where you set its name, personality, and how it handles tasks. When you ask Thorn to do something complex, it delegates to the rest of the team.

**2. Your agent team**

Defined in `agents/company.js`. Each agent has an ID, a role, a department, a model, and a personality. Agents are stored in the SQLite database and appear on the dashboard.

**3. The agent worker**

A separate process (`dist/agent-worker.js`) that polls the `agent_tasks` table every 2 seconds. When a task is assigned to an agent, the worker picks it up, runs Claude with the agent's persona and the task description, logs progress to the dashboard, and marks it done.

### The full flow

```
You → Telegram → Thorn
                   ↓ (creates task in SQLite)
              Agent Worker picks it up
                   ↓
              Runs Claude with agent persona + task
                   ↓
              Logs progress to dashboard (live)
                   ↓
              Marks task done, notifies you via Telegram
```

---

## Starting the agent worker

The worker runs separately from the main bot:

```bash
# Build first if you haven't
npm run build

# Start the worker
node dist/agent-worker.js

# Or with PM2 (recommended for always-on)
pm2 start dist/agent-worker.js --name agent-worker
pm2 save
```

You'll see it appear in the dashboard once it's running.

---

## Your team file: `agents/company.js`

This is your company structure. It exports three objects:

- `COMPANY` — company name and department list
- `AGENTS` — every agent's definition
- `ORG_CHART` — reporting structure

The file ships with a complete example team. Use it as a template — rename agents, change departments, adjust models, rewrite personalities. Make it yours.

### Agent definition structure

```js
'agent-id': {
  id: 'agent-id',           // unique slug, used everywhere
  name: 'First',            // short name shown in dashboard
  fullName: 'Full Name',
  title: 'Role — Specialty',
  department: 'engineering',
  role: 'director',         // 'ceo' | 'director' | 'employee'
  emoji: '⚙️',              // shown in dashboard and notifications
  model: 'claude-sonnet-4-5',
  reportsTo: 'other-agent-id',  // omit for top-level agents
  personality: {
    description: 'One paragraph. Background, approach, values.',
    style: 'How they communicate.',
    strengths: ['thing 1', 'thing 2'],
    blindSpots: ['weakness 1'],
    likes: ['interest 1', 'interest 2'],
    quirks: 'One memorable trait.',
  },
},
```

### Available models

Pick based on task complexity and cost:

| Model | Best for | Cost |
|-------|----------|------|
| `claude-opus-4-6` | Complex reasoning, architecture decisions | High |
| `claude-sonnet-4-5` | Directors, most tasks | Medium |
| `claude-haiku-4-5` | Workers, repetitive tasks, high volume | Low |

---

## Registering agents in the database

After editing `agents/company.js`, sync your team to the database. The dashboard reads from the DB, not the file.

The easiest way: ask Thorn from Telegram:

```
Register my full agent team from agents/company.js into the database
```

Or do it manually via the API (the dashboard server must be running):

```bash
curl -s -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "id": "agent-id",
    "name": "First",
    "full_name": "Full Name",
    "title": "Role — Specialty",
    "department": "engineering",
    "role": "employee",
    "emoji": "⚙️",
    "model": "claude-haiku-4-5",
    "reports_to": "director-id",
    "status": "active"
  }'
```

Or directly in SQLite:

```bash
sqlite3 store/claudeclaw.db \
  "INSERT INTO agents (id, name, full_name, title, department, role, emoji, model, reports_to, status, updated_at)
   VALUES ('agent-id', 'First', 'Full Name', 'Role', 'engineering', 'employee', '⚙️', 'claude-haiku-4-5', 'director-id', 'active', unixepoch())"
```

---

## Delegating tasks to agents

### From Telegram (natural language)

Tell Thorn what you need and who should handle it. Thorn creates the task and assigns it:

```
Ask Marcus to review the architecture of our new API and flag any reliability risks
```

```
Have Sofia write three LinkedIn posts about our product launch for this week
```

```
Tell Jordan to pull last month's LLM costs and flag anything over $5
```

Thorn routes automatically based on agent roles defined in `CLAUDE.md`.

### From code (direct task creation)

```bash
TASK_RESPONSE=$(curl -s -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Review API architecture",
    "description": "You are Marcus, CTO. Review the API structure in src/api/ and identify any reliability or scaling issues. Write a brief report.",
    "assignee_id": "marcus-reyes",
    "assignee_name": "Marcus",
    "department": "engineering",
    "priority": "high",
    "status": "todo"
  }')
echo $TASK_RESPONSE
```

The worker picks this up within 2 seconds and starts executing.

### Task status values

| Status | Meaning |
|--------|---------|
| `todo` | Waiting for the worker to pick it up |
| `in_progress` | Worker is running the agent |
| `done` | Task completed |
| `failed` | Task failed (worker will retry up to 3 times) |

---

## Watching agents work

### Dashboard

The Tasks page shows live progress with a progress bar. Each agent logs messages to the thread as it works — you can see what it's doing step by step.

The Activity feed (homepage) shows a live stream of every action across all agents.

### Telegram notification

When an agent finishes, it sends you a message:

```
Listo. Marcus reviewed the API architecture. Found two issues:
missing rate limiting on /upload, and the auth middleware runs
redundant DB lookups. PR with fixes ready.
```

---

## Designing agent personalities

Personality isn't just flavor — it changes how the agent reasons and communicates. A few principles:

**Be specific about communication style.** "Directo, sin rodeos" is better than "professional". "Explains decisions without condescending" changes how it writes code comments. "Never says 'Certainly!'" actually works.

**Define actual strengths, not job titles.** "TypeScript generics and Tailwind layout debugging" is better than "frontend". The agent will pull from the strength list when deciding how to approach a task.

**Include blindspots.** They make agents feel real and help you understand when to add a check on their work. "Tends to over-engineer simple things" is a real signal.

**Match model to role.** Directors making decisions → Sonnet. Workers executing repetitive tasks → Haiku. Complex reasoning tasks → Opus.

---

## Auto-hiring new agents

When Thorn encounters a task nobody on the team can handle, it can hire a new agent on the fly. The full hiring flow:

1. Register the agent in the database via the API
2. Log the hire in the team chat (dashboard → Virtual Office)
3. Add to org-chart
4. Generate an avatar (optional — DALL-E 3)

Tell Thorn to do this automatically:

```
We need a Legal agent who can review contracts and flag compliance issues.
Hire one.
```

Thorn creates the agent, logs the hire, and it appears in the dashboard immediately.

---

## Example: building a team from scratch

Here's the minimal starting point — a CEO assistant and two workers:

```js
const AGENTS = {

  // Your assistant — talks to you on Telegram
  'alex': {
    id: 'alex',
    name: 'Alex',
    fullName: 'Alex',
    title: 'Personal Assistant',
    department: 'executive',
    role: 'ceo',
    emoji: '🤖',
    model: 'claude-sonnet-4-5',
    personality: {
      description: 'Direct, no fluff. Gets things done.',
      style: 'Short answers. No AI clichés.',
      strengths: ['coordination', 'quick decisions'],
      blindSpots: ['can move too fast'],
      likes: ['clean systems', 'short messages'],
      quirks: 'Calls out anything that wastes time.',
    },
  },

  // Engineering director
  'dev': {
    id: 'dev',
    name: 'Dev',
    fullName: 'Dev',
    title: 'Engineering Lead',
    department: 'engineering',
    role: 'director',
    emoji: '⚙️',
    model: 'claude-sonnet-4-5',
    personality: {
      description: 'Builder. Pragmatic. Ships fast.',
      style: 'Technical but clear.',
      strengths: ['code review', 'architecture', 'debugging'],
      blindSpots: ['skips documentation'],
      likes: ['clean code', 'good tests'],
      quirks: '"This doesn\'t scale" is a reflex.',
    },
  },

  // Research worker
  'scout': {
    id: 'scout',
    name: 'Scout',
    fullName: 'Scout',
    title: 'Research Analyst',
    department: 'intelligence',
    role: 'employee',
    emoji: '🔍',
    model: 'claude-haiku-4-5',
    reportsTo: 'dev',
    personality: {
      description: 'Finds things nobody else finds.',
      style: 'Bullet points, sources cited.',
      strengths: ['web research', 'competitive intel', 'summarizing'],
      blindSpots: ['rabbit holes'],
      likes: ['primary sources', 'Reddit for early signals'],
      quirks: 'Always includes what they didn\'t find.',
    },
  },

};
```

Then update `CLAUDE.md` to route tasks correctly:

```
Engineering → Dev (dev)
Research → Scout (scout)
```

Register them in the DB, start the agent worker, and you're live.

---

## Routing in CLAUDE.md

For Thorn to delegate correctly, your `CLAUDE.md` needs a routing table. Add this section and customize it for your team:

```markdown
## How to route work

- Code, architecture, debugging → Dev (dev, engineering)
- Research, competitive intel, web → Scout (scout, intelligence)
- Writing, copy, content → [your content agent]
- Finance, costs, budget → [your finance agent]
- Cross-department tasks → coordinate multiple agents in parallel
```

---

## Watching costs

Each model run is logged to the `token_usage` table. The Finance dashboard page shows per-agent costs. If an agent is expensive, swap its model in `agents/company.js` and re-register.

The rule of thumb: use Haiku for anything that doesn't require judgment. Save Sonnet for decisions. Only pull in Opus when it genuinely matters.

---

## Troubleshooting

**Agent worker isn't picking up tasks**
- Make sure `dist/agent-worker.js` exists (run `npm run build`)
- Check it's running: `pm2 list` or `ps aux | grep agent-worker`
- Look at logs: `pm2 logs agent-worker` or `tail -f logs/agent-worker.log`

**Task stuck in `in_progress`**
- Worker crashed mid-task. Restart it: `pm2 restart agent-worker`
- The task will be retried automatically on next worker start

**Agent not showing in dashboard**
- Not registered in DB. Use the API or `sqlite3` to add it (see above)
- Dashboard caches for 5 seconds — wait or refresh

**Agent keeps failing**
- Check task description: vague prompts = vague results. Add specific success criteria
- Check model: some tasks need Sonnet, not Haiku
- Check logs for the specific error message
