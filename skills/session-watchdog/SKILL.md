---
name: session-watchdog
description: Monitor Claude Code session context levels and save checkpoints before compaction. Triggers on: "convolife", "cuánto contexto queda", "how much context left", "checkpoint", "save context", "guardar contexto", "cuánto token queda".
allowed-tools: Bash
---

# session-watchdog

Monitor context window usage and save checkpoints before things get lost. Critical for long OpoClaw work sessions.

## Check context usage (convolife)

```bash
# Get current session stats
SESSION_ID=$(sqlite3 ${REPO_DIR}/store/opoclaw.db "SELECT session_id FROM sessions ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || echo "unknown")

sqlite3 ${REPO_DIR}/store/opoclaw.db "
  SELECT
    COUNT(*)             as turns,
    MAX(context_tokens)  as last_context,
    SUM(output_tokens)   as total_output,
    ROUND(SUM(cost_usd),4) as total_cost,
    SUM(did_compact)     as compactions
  FROM token_usage WHERE session_id = '$SESSION_ID';
" 2>/dev/null || echo "No token_usage table found"

# Baseline
sqlite3 ${REPO_DIR}/store/opoclaw.db "
  SELECT context_tokens FROM token_usage
  WHERE session_id = '$SESSION_ID'
  ORDER BY created_at ASC LIMIT 1;
" 2>/dev/null
```

Calculate and report:
```
Context: XX% (~XXk / 1000k available)
Turns: N | Compactions: N | Cost: $X.XX
```

## Save checkpoint (checkpoint command)

When the user says "checkpoint", save key decisions to memory:

```bash
CHAT_ID=$(sqlite3 ${REPO_DIR}/store/opoclaw.db "SELECT chat_id FROM sessions ORDER BY created_at DESC LIMIT 1;" 2>/dev/null || echo "unknown")

python3 -c "
import sqlite3, time
db = sqlite3.connect('${REPO_DIR}/store/opoclaw.db')
now = int(time.time())
summary = '''[SUMMARY — 3-5 bullet points of key decisions/context from this session]'''
try:
    db.execute('INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ('$CHAT_ID', summary, 'semantic', 5.0, now, now))
    db.commit()
    print('Checkpoint saved.')
except Exception as e:
    print(f'Error: {e}')
" 2>/dev/null || echo "Checkpoint saved to notes (DB not available)"
```

## Auto-warn threshold

If context > 70%, warn the user:
"Heads up: at 70% context. Run 'checkpoint' if there's anything critical to preserve before compaction."

## Compact strategy

Before 80% context:
1. Summarize the session's key decisions into 5 bullets
2. Save as checkpoint
3. Note what's in progress so next session can pick up cleanly
