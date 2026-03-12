---
name: docsync
description: Auto-generate or update documentation from code changes. Triggers on: "document this code", "update the docs", "genera documentación", "write docs for", "add README", "document this function", "update CLAUDE.md", "write a changelog".
allowed-tools: Bash
---

# docsync

Auto-generate documentation from code. Designed for Lucas (frontend) and Elias (backend) in OpoClaw.

## Document types

1. **Function/API docs** — from code signatures and comments
2. **README** — project overview, setup, usage
3. **Changelog** — from git log
4. **CLAUDE.md section** — agent instructions for new features
5. **Architecture decision** — ADR format

## Workflow

### Generate from git log (changelog)

```bash
# Last 2 weeks of commits formatted as changelog
git -C ${REPO_DIR} log \
  --since="2 weeks ago" \
  --pretty=format:"%ad — %s" \
  --date=short \
  --no-merges \
  2>/dev/null | head -30
```

### Document an API endpoint

Given an endpoint, produce:
```
### POST /api/agents/:id/chat
Stream a chat message to a specific agent.

**Request body:**
- `message` (string, required): The message to send

**Response:** Server-Sent Events stream
- `data: {"token": "..."}` — streaming token
- `data: [DONE]` — stream complete

**Example:**
curl -X POST http://localhost:3001/api/agents/thorn/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What are your current tasks?"}'
```

### Detect documentation drift

```bash
# Find functions without comments
grep -rn "^function\|^const.*=.*=>" ${REPO_DIR}/src/ \
  --include="*.ts" | grep -v "//" | head -20

# Find endpoints without documentation
grep -n "app\.\(get\|post\|patch\|delete\)" ${REPO_DIR}/src/dashboard-server.ts | head -20
```

### Update CLAUDE.md

When a new feature is added to OpoClaw, append to CLAUDE.md:
```bash
cat >> ${REPO_DIR}/CLAUDE.md << 'EOF'

## [Feature Name] — Added [DATE]
[One paragraph: what it does, how to use it, any agent-specific notes]
EOF
```

## Log activity

```bash
sqlite3 ${REPO_DIR}/store/opoclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('lucas-park','Lucas','🎨','Generated/updated documentation','success','engineering',datetime('now'))"
```
