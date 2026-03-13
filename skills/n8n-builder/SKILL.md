---
name: n8n-builder
description: Build, describe, or troubleshoot n8n automation workflows. Triggers on: "build an n8n workflow", "automatiza esto con n8n", "n8n flow for", "workflow automation", "automate with n8n", "crea un flujo en n8n", "n8n trigger for".
allowed-tools: Bash, WebSearch
---

# n8n-builder

Design and build n8n automation workflows. Designed for Silas (automation) in OpoClaw. n8n runs locally or via cloud.

## What n8n does

n8n is a workflow automation tool (like Zapier but self-hostable). It connects apps and automates sequences via a visual node editor.

## Common OpoClaw n8n use cases

1. **Telegram → agent dispatch**: Incoming Telegram message → webhook → OpoClaw API
2. **Morning brief trigger**: Cron → fetch emails + calendar + news → compile → send via Telegram
3. **Lead capture**: Form submission → add to Neon DB → notify Thorn via Telegram
4. **Content pipeline**: RSS feed → summarize with AI → draft post → schedule via Publora
5. **Cost alert**: Cron → check Jordan's cost API → if over threshold → alert the user

## Design a workflow

Output a structured workflow spec:

```
WORKFLOW: [name]
TRIGGER: [what starts it — Cron / Webhook / Manual / App event]
NODES:
  1. [Node type] — [what it does] — [input → output]
  2. [Node type] — [what it does] — [input → output]
  3. [Node type] — [what it does] — [input → output]
ERROR HANDLING: [what happens on failure]
OUTPUT: [what the workflow produces]
```

## n8n API (if n8n is running)

```bash
# Check if n8n is running
curl -s http://localhost:5678/api/v1/workflows -H "X-N8N-API-KEY: $N8N_API_KEY" | python3 -m json.tool

# List workflows
curl -s "http://localhost:5678/api/v1/workflows" -H "X-N8N-API-KEY: $N8N_API_KEY"

# Trigger a workflow manually
curl -s -X POST "http://localhost:5678/api/v1/workflows/[ID]/run" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Install n8n locally (if needed)

```bash
npm install -g n8n
n8n start &
# runs at http://localhost:5678
```

## Log activity

```bash
sqlite3 ${REPO_DIR}/store/opoclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('silas-vane','Silas','⚡','Built n8n automation workflow','success','engineering',datetime('now'))"
```
