---
name: okr-tracker
description: Set, track, and review OKRs (Objectives and Key Results) for Gonzalo's ventures. Triggers on: "set OKRs", "review OKRs", "track goals", "objectivos y resultados clave", "mis metas del trimestre", "quarterly goals", "OKR check-in", "update my goals".
allowed-tools: Bash
---

# okr-tracker

Set and track OKRs for Gonzalo's business. Backed by SQLite, visible in the dashboard. Designed for Thorn to manage on Gonzalo's behalf.

## Storage

OKRs are stored in: `/Users/opoclaw1/claudeclaw/store/claudeclaw.db` in the `tasks` table (using type=okr).

Or as a markdown file: `/Users/opoclaw1/claudeclaw/workspace/okrs.md`

## Commands

### View current OKRs
```bash
cat /Users/opoclaw1/claudeclaw/workspace/okrs.md 2>/dev/null || echo "No OKRs file yet"
```

### Set new OKR (quarterly)
```bash
QUARTER=$(date +Q%q-%Y)
cat > /Users/opoclaw1/claudeclaw/workspace/okrs.md << EOF
# OKRs — $QUARTER

## O1: [OBJECTIVE — ambitious, qualitative]
- KR1.1: [measurable result] → target: [N] → current: [N]
- KR1.2: [measurable result] → target: [N] → current: [N]
- KR1.3: [measurable result] → target: [N] → current: [N]

## O2: [OBJECTIVE]
- KR2.1: [measurable result] → target: [N] → current: [N]

## Weekly check-in: [DATE]
## Score: [0-1 per KR, average at the end]
EOF
echo "OKRs created for $QUARTER"
```

### Update KR progress
Edit the okrs.md file directly with current numbers.

### Weekly check-in
Calculate completion % for each KR. Target: 0.7 is good. 1.0 means too easy.

## OKR rules

- Objectives: qualitative, inspiring, clear
- Key Results: quantitative, measurable, verifiable
- Max 3 objectives per quarter
- Max 3 KRs per objective
- No tasks as KRs — outcomes only

## Log update
```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('thorn','Thorn','🌵','Updated OKR tracker','success','executive',datetime('now'))"
```
