#!/bin/bash
# propose-skill.sh — Submit a skill proposal with automatic dedup
# Usage: propose-skill.sh "skill-slug" "Skill Name" "description" "proposed_by_agent_id"
# Example: propose-skill.sh "email-outreach" "Email Outreach" "Sends cold emails to prospects" "finn-cole"

SLUG="$1"
NAME="$2"
DESC="$3"
BY="$4"
NOW=$(date +%s)

if [ -z "$SLUG" ] || [ -z "$NAME" ]; then
  echo "ERROR: Usage: propose-skill.sh <slug> <name> [description] [proposed_by]"
  exit 1
fi

# Check for duplicate by slug
EXISTING=$(sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db "SELECT id FROM skill_proposals WHERE skill_slug='$SLUG';")
if [ -n "$EXISTING" ]; then
  echo "SKIP: Skill '$SLUG' already proposed (id=$EXISTING). No duplicate created."
  exit 0
fi

# Insert proposal into skill_proposals table
sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db "INSERT INTO skill_proposals (skill_name, skill_slug, description, proposed_by, status, created_at, updated_at) VALUES ('$NAME', '$SLUG', '$DESC', '$BY', 'proposed', $NOW, $NOW);"

# Also save to memories for semantic recall
python3 -c "
import sqlite3, time
db = sqlite3.connect('/Users/opoclaw1/claudeclaw/store/opoclaw.db')
content = 'Skill proposal: $NAME ($SLUG) -- $DESC. Proposed by $BY.'
db.execute('INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)', ('system', content, 'skill_proposal', 3.0, $NOW, $NOW))
db.commit()
print('Skill proposal saved to memory.')
"

# Log to activity feed
sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db "INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at) VALUES ('$BY', '$BY', '🔧', 'Skill propuesto: $NAME ($SLUG)', 'info', 'engineering', datetime('now'))"

# Notify via Telegram
bash /Users/opoclaw1/claudeclaw/scripts/tg-notify.sh "Skill propuesto: $NAME ($SLUG). En cola para revision de Marcus."

echo "OK: Skill '$NAME' ($SLUG) proposed by $BY."
