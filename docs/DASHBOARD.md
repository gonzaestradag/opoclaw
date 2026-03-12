# Dashboard — Pages Reference

OpoClaw includes a full React web dashboard. It runs locally on port 3001 and shows everything happening inside your system in real time.

Open it from Telegram with `/dashboard`, or go to `http://localhost:3001` in your browser.

For setup and remote access (Cloudflare Tunnel), see the [Dashboard section in the README](../README.md#dashboard-optional).

---

## Quick start

```bash
# Install dashboard dependencies (only once)
cd dashboard && npm install && cd ..

# Build and start
npm run build
npm start  # starts both the bot and the dashboard server
```

The dashboard comes up on port `3001` by default. To change it:
```
DASHBOARD_PORT=4000   # in your .env
```

---

## Pages

### Home

Your command center. Shows a live overview of everything happening right now:

- **Live trading** — real-time Binance prices, open positions, P&L
- **Team activity feed** — every agent action as it happens
- **Active tasks** — what's in progress across the whole team
- **Recent messages** — latest inter-agent communication
- **Calendar** — today's events from Google Calendar
- **Org tree** — your company structure at a glance
- **Revenue feed** — latest revenue events

The homepage auto-refreshes via Server-Sent Events. No page reload needed.

---

### My Day

Your personal planning view for today.

- **Calendar** — today's events pulled from Google Calendar
- **Tasks** — your personal task list for the day
- **Priorities** — what to focus on, set manually or via Thorn

Best used first thing in the morning. Ask Thorn to populate it:
```
Set up my day — pull today's calendar and add the three things I need to finish
```

---

### Agents

Your full team. One card per agent showing:

- Name, title, department, model
- Current status (idle / busy / error)
- Active task (if any) with live progress bar
- Recent activity from this agent
- Chat thread — messages to and from this agent

Click any agent to go deep: full history, all tasks assigned, KPI summary.

You can also trigger tasks directly from this page without going through Telegram.

---

### Tasks

The task board. Full view of everything assigned to the team:

**Filters:**
- By status: todo / in progress / done / failed
- By department: engineering, intelligence, operations, finance, content, strategy
- By priority: urgent, high, medium, low
- By agent

**Each task shows:**
- Title, description, assignee
- Live progress bar (updates in real time via SSE)
- Message thread — every step the agent logged while working
- Time created, started, and completed

Click any task to open the full detail view with the complete agent communication thread.

---

### Inbox

Unified message center across all channels:

- **Telegram** — your messages and Thorn's replies
- **Slack** — messages from connected workspaces
- **WhatsApp** — messages from connected account

All in one scrollable list, sorted by time. Click any message to see the full thread.

---

### Morning Briefs

Your daily AI-generated audio briefing.

- **Schedule** — set what time you want your brief each morning
- **Sections** — toggle what's included: calendar, news, market update, tasks, weather
- **Player** — listen directly in the browser
- **History** — browse all past briefs

The brief is generated automatically via cron, converted to audio via ElevenLabs, and sent to your Telegram. This page lets you play it from the dashboard instead.

---

### Brain Vault

Your document knowledge base. Anything important that agents should be able to reference.

- **Add documents** — paste text, upload files, or have agents save things here
- **Search** — full-text search across all stored docs
- **Categories** — organize by topic

Agents with the right prompt can read from Brain Vault when answering questions. Useful for: SOPs, product specs, reference docs, anything you'd otherwise re-explain.

---

### Memory Viewer

Browse everything OpoClaw remembers about you.

- **All memories** — sorted by salience (highest = most important, most used)
- **Semantic** — long-lived facts (preferences, habits, context)
- **Episodic** — transient events that fade over time
- **Search** — FTS5 search across all memory content
- **Edit salience** — boost or reduce how long a memory survives
- **Delete** — remove individual memories

Useful for auditing what your assistant knows and cleaning out stale context.

See [Memory in the README](../README.md#memory) for how the decay system works.

---

### Virtual Office

Your team's communication hub. Think of it as a company Slack.

- **Team chat** — see all inter-agent messages across all threads
- **Hiring feed** — every time an agent is hired, it appears here
- **Department threads** — filter by engineering, intelligence, operations, etc.
- **Org chart** — visual tree of your full company structure

This is where you see agents talking to each other. When Thorn delegates something to Marcus, when Marcus asks Lucas for help, when Lucas reports back — all of it shows up here.

---

### Meetings

Schedule and run meetings with your agent team.

- **Upcoming** — scheduled meetings with agenda and participants
- **Active** — join a live meeting with real-time notes
- **Past** — full transcripts and recordings from completed meetings
- **Notes** — AI-generated meeting notes automatically saved after each session

Start a meeting from Telegram:
```
Schedule a strategy meeting with Marcus and Aria for tomorrow at 3pm
```

---

### Ventures

Your opportunity pipeline. Track new business ideas from first signal to decision.

- **Pipeline** — opportunities by stage (exploring → validating → building → live)
- **Research** — competitive analysis, market sizing, revenue models
- **Playbook** — your SOP for evaluating new ventures

Victoria (Ventures Director, if you have one) updates this automatically when you ask her to research an opportunity.

---

### Finance

Your budget and spending control center.

- **LLM costs** — per-model breakdown: what each model cost today, this week, this month
- **Per-agent costs** — which agents are most expensive to run
- **Monthly trend** — 30-day cost chart
- **Budget alerts** — set a monthly limit and get notified when you're close

Jordan (Finance Director) reviews this automatically and flags anomalies.

---

### Trading

Live view of your Binance positions (requires `BINANCE_API_KEY` in `.env`).

- **Balances** — current holdings per coin
- **P&L** — total gain/loss, realized and unrealized
- **Order history** — every executed trade
- **Bot status** — which trading bots are active

The bots run 24/7 via PM2. This page is read-only — configure bot strategy in `src/trading/config.ts`.

---

### Revenue

Track your business revenue.

- **Monthly view** — revenue by month with trend
- **Revenue events** — individual payments, subscriptions, invoices
- **Live feed** — new revenue events show up in real time
- **Projections** — run-rate forecast

Add revenue events manually or have agents log them automatically when they process invoices or payment notifications.

---

### Skills

Your Claude Code skills library.

- **Installed** — every skill in `~/.claude/skills/` (auto-detected)
- **Available** — skills that ship with OpoClaw but aren't installed yet
- **Add skill** — install a new skill from a URL or local path
- **Configure** — view and edit each skill's `SKILL.md`

This page is a reference — the actual invocation happens naturally through Thorn based on what you ask.

---

### Calls

Call management (requires Vapi integration).

- **Recording library** — all call recordings
- **Transcripts** — full text of each call
- **Inject** — send a call transcript to Thorn for analysis

---

### Recordings

Audio/video clip library. Anything downloaded or generated by the system:

- Morning brief audio files
- ElevenLabs TTS outputs
- Telegram voice notes (if saved)
- Call recordings

---

### Approvals

Pending decisions that need your input.

When agents need approval before taking an action (sending an email, making a purchase, deploying something), they create an approval request here instead of acting unilaterally.

- **Pending** — waiting for your decision
- **Approve / Reject** — one tap
- **History** — all past approvals

Configure which actions require approval in `CLAUDE.md`.

---

### Settings

Dashboard and system configuration.

- **Integrations** — connect/disconnect Google, Slack, WhatsApp, Binance
- **Notifications** — control which events send Telegram messages
- **Theme** — light/dark mode toggle
- **Agents** — add/edit/remove agents from this page (syncs to DB)
- **Dashboard password** — rotate your dashboard token

---

## Real-time updates

The dashboard uses Server-Sent Events (SSE) — a persistent connection where the server pushes updates to the browser instantly. No polling, no manual refresh.

Events that trigger live updates:
- Task progress changes
- Agent activity
- New messages in Virtual Office
- Trading price updates
- Approval requests
- Revenue events

If the connection drops, the dashboard reconnects automatically.

---

## Remote access (Cloudflare Tunnel)

To access the dashboard from your phone when away from your machine, set up a Cloudflare Tunnel. Full instructions in the [README](../README.md#step-5-optional--access-from-your-phone-anywhere).

Short version:
```bash
cloudflared tunnel --url http://localhost:3001
```

Copy the printed URL, add it to `.env`:
```
DASHBOARD_URL=https://something.trycloudflare.com
```

Restart the bot. Now `/dashboard` in Telegram sends you a link that works anywhere.

---

## Building the dashboard

The dashboard is a React/Vite app in the `dashboard/` folder. After making changes to any file in `dashboard/src/`:

```bash
cd dashboard && npm run build && cd ..
npm start
```

Or use the deploy script:
```bash
bash scripts/deploy-dashboard.sh
```

Changes to the backend API (`src/dashboard-server.ts`) also require a rebuild.
