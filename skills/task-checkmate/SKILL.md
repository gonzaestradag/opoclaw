---
name: task-checkmate
description: Turn a goal into concrete pass/fail success criteria and verify whether an agent's output actually meets them. Triggers on: "did this work", "verifica si se logró", "check the output", "did the agent do it right", "validate this result", "define success criteria for", "qué significa que esto esté listo".
allowed-tools: Bash
---

# task-checkmate

Turn vague goals into verifiable criteria, then check if the work actually passes. Prevents agents from marking tasks "done" when they're not. Used by Thorn to verify agent outputs.

## Workflow

### Mode 1: Define criteria (before work starts)

Given a goal, produce a checklist of PASS/FAIL items:

```
GOAL: "[what the agent was asked to do]"

SUCCESS CRITERIA:
[ ] 1. [specific, verifiable condition]
[ ] 2. [specific, verifiable condition]
[ ] 3. [specific, verifiable condition]

FAILURE CONDITIONS (any = fail):
- [condition that means it didn't work]
- [condition that means it didn't work]

EVIDENCE REQUIRED:
- [what proof makes it real? Neon log, file path, URL, screenshot?]
```

### Mode 2: Verify output (after work is done)

Given the agent's output, check it against criteria:

```bash
# Example: verify a file was created
ls -la [expected file path]
# verify DB record exists
sqlite3 ${REPO_DIR}/store/opoclaw.db \
  "SELECT * FROM agent_activity WHERE agent_id='[id]' AND created_at > datetime('now','-5 minutes');"
# verify API returned success
curl -s http://localhost:3001/api/agents/[id] | python3 -m json.tool
```

### Output

```
TASK: [what was asked]
RESULT: PASS / FAIL / PARTIAL

CRITERIA CHECK:
[x] 1. [criterion] — PASS (evidence: ...)
[ ] 2. [criterion] — FAIL (what's missing)
[x] 3. [criterion] — PASS

VERDICT: [one sentence — done or what's still needed]
```

## Integration with OpoClaw

When marking a task done in Neon:
- PASS → update task status to 'done'
- FAIL → update status to 'failed', add failure note
- PARTIAL → status stays 'in_progress', add what remains

```bash
# Mark verified done
curl -s -X PATCH http://localhost:3001/api/tasks/[TASK_ID] \
  -H "Content-Type: application/json" \
  -d '{"status":"done","progress":100}'
```
