---
name: morning-rollup
description: Generate Gonzalo's morning brief — urgent emails, today's calendar, top priorities, and key news. Triggers on: "morning brief", "brief del día", "resumen de la mañana", "qué tengo hoy", "what's on today", "daily rollup", "morning update", "buenos días qué hay", "buenos días".
allowed-tools: Bash, WebSearch
---

# morning-rollup

Generate Gonzalo's daily morning brief. Designed for Maya (operations) to run automatically at 7am or on demand.

## Structure

```
MORNING BRIEF — [Day, Date]
━━━━━━━━━━━━━━━━━━━━━━━

TODAY'S FOCUS
[1 sentence: the single most important thing to accomplish today]

CALENDAR
[upcoming events today, from Google Calendar]

PRIORITY INBOX
[2-3 most urgent/important emails from Gmail]

AGENT STATUS
[any tasks that completed overnight, any failures]

NEWS (relevant to Gonzalo's work)
[1-2 headlines relevant to AI, startups, or OpoClaw's verticals]

TODAY'S TOP 3
1. [most important task]
2. [second most important]
3. [third]
```

## Data sources

### Pre-seeded brief context (check first)

```bash
# Check for pre-seeded brief context from nightly cycle
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "SELECT content FROM brief_context WHERE status='pending' ORDER BY created_at DESC LIMIT 5;" 2>/dev/null
# If results exist, incorporate them into the brief and mark as used:
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "UPDATE brief_context SET status='used' WHERE status='pending';" 2>/dev/null
```

### Calendar events

```bash
# Try Google Calendar via API
CAL_RESULT=$(curl -s "http://localhost:3001/api/calendar/events?date=$(date +%Y-%m-%d)" 2>/dev/null)
echo "$CAL_RESULT"

# Fallback: check local calendar_events table
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "SELECT title, start_time, end_time FROM calendar_events WHERE date(start_time) = date('now') ORDER BY start_time;" 2>/dev/null
```

### Gmail urgent emails

```bash
# Try Gmail API via OpoClaw gateway
curl -s "http://localhost:3001/api/gmail/inbox?limit=5" 2>/dev/null | python3 -c "
import sys, json
try:
    msgs = json.load(sys.stdin)
    for m in msgs[:3]: print(f\"- {m.get('from','?')}: {m.get('subject','?')}\")
except: pass
" 2>/dev/null || echo "Gmail not available — skip inbox section"
```

### OpoClaw agent overnight activity

```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "SELECT agent_name, action, type, created_at FROM agent_activity
   WHERE created_at > datetime('now','-10 hours')
   ORDER BY created_at DESC LIMIT 10;" 2>/dev/null
```

### Failed tasks (needs attention)

```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "SELECT title, assignee_name FROM agent_tasks WHERE status='failed' AND created_at > datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 5;" 2>/dev/null
```

### In-progress tasks (carried over)

```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "SELECT title, assignee_name, progress FROM agent_tasks WHERE status='in_progress' ORDER BY created_at DESC LIMIT 5;" 2>/dev/null
```

### AI / startup news (if not pre-seeded)

Only run WebSearch if no pre-seeded news was found in brief_context above:

```
WebSearch: "AI news today [CURRENT DATE]"
WebSearch: "startup technology news [CURRENT DATE]"
```

Pick the 2 most relevant results — prioritize AI agents, automation, or things directly relevant to OpoClaw verticals.

## Output format

Plain text, no markdown headers (this goes to Telegram voice or text).
Max 250 words total.
Lead with what matters most.
One clear "DO THIS FIRST" action item.
No emojis. No em dashes. No filler phrases.

If a section has no data (no calendar events, no email), skip it — do not say "no events found". Only include sections that have real content.

## Edge cases

- **No calendar access**: Skip CALENDAR section silently.
- **No Gmail access**: Skip PRIORITY INBOX section silently.
- **No news pre-seeded**: Run a quick WebSearch for today's date.
- **No agent activity overnight**: Skip AGENT STATUS or say "All agents idle overnight."
- **Weekend morning**: Skip "Today's Top 3" if it's Saturday or Sunday and Gonzalo hasn't given any indication of working. Add a short personal note instead.

## Schedule automatically

```bash
# Add to cron at 7am weekdays
# node /Users/opoclaw1/claudeclaw/dist/schedule-cli.js create "Generate morning brief for Gonzalo" "0 7 * * 1-5"
```

## Log completion

```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('maya-chen','Maya','🎯','Morning brief generated and sent to Gonzalo','success','operations',datetime('now'))"
```
