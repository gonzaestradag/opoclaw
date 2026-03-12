#!/usr/bin/env bash
# nightly-iq-boost.sh — Self-improvement loop for all OpoClaw agents
# Runs every night. Each agent analyzes its own performance, researches new
# techniques, updates its knowledge file, and creates new skills if gaps found.
# SILENT — zero Telegram, zero output to console.

DB="/Users/opoclaw1/claudeclaw/store/opoclaw.db"
AGENTS_DIR="/Users/opoclaw1/claudeclaw/workspace/agents"
SKILLS_DIR="/Users/opoclaw1/.claude/skills"
LOG="/tmp/iq-boost-$(date +%Y%m%d).log"
TODAY=$(date +%Y-%m-%d)

log() { echo "[$(date '+%H:%M:%S')] $1" >> "$LOG"; }
log "=== Nightly IQ Boost started ==="

# ── Agent registry — bash 3.2 compatible (no associative arrays) ───────────
# Format: AGENT_ID:ROLE_DESCRIPTION (pipe-delimited list)
AGENT_REGISTRY=(
  "thorn:COO and Chief of Staff. Expert in orchestration, delegation, decision-making, multi-agent coordination, and being Gonzalo's most trusted executive partner."
  "marcus-reyes:CTO and Engineering Director. Expert in software architecture, system design, code quality, AI integration, and technical leadership."
  "lucas-park:Frontend Engineer. Expert in React, TypeScript, Vite, UI/UX, component design, performance optimization, and modern web development."
  "elias-mora:Backend Engineer. Expert in Node.js, APIs, databases, server architecture, integrations, and data pipelines."
  "silas-vane:DevOps and Automation Engineer. Expert in PM2, bash scripting, CI/CD, system reliability, monitoring, and deployment automation."
  "rafael-silva:Intelligence Director. Expert in market research, competitive analysis, web scraping, news analysis, and strategic intelligence gathering."
  "kaelen-ward:Deep Research Analyst. Expert in synthesis, long-form research reports, pattern recognition, and turning data into actionable insights."
  "maya-chen:Operations Manager. Expert in scheduling, process optimization, email management, calendar coordination, and operational efficiency."
  "jordan-walsh:Finance Director. Expert in financial analysis, cost optimization, P&L tracking, budgeting, and revenue forecasting."
  "sofia-ramos:Content Director. Expert in copywriting, SEO, content strategy, brand voice, and high-converting written content."
  "aria-nakamura:Strategy Director. Expert in business strategy, roadmapping, OKRs, market positioning, and long-term planning."
  "victoria-cross:Ventures Director. Expert in new business development, market analysis, pitch decks, go-to-market strategy, and opportunity evaluation."
)

# ── Process each agent ─────────────────────────────────────────────────────
for ENTRY in "${AGENT_REGISTRY[@]}"; do
  AGENT_ID="${ENTRY%%:*}"
  ROLE="${ENTRY#*:}"
  KNOWLEDGE_FILE="$AGENTS_DIR/$AGENT_ID/knowledge.md"
  mkdir -p "$AGENTS_DIR/$AGENT_ID"

  log "Processing $AGENT_ID..."

  # Pull last 7 days of activity from DB
  SUCCESSES=$(sqlite3 "$DB" "
    SELECT action FROM agent_activity
    WHERE agent_id='$AGENT_ID' AND type='success'
      AND created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC LIMIT 30;
  " 2>/dev/null | head -20)

  FAILURES=$(sqlite3 "$DB" "
    SELECT action FROM agent_activity
    WHERE agent_id='$AGENT_ID' AND type IN ('error','warning')
      AND created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC LIMIT 20;
  " 2>/dev/null | head -15)

  TASKS_DONE=$(sqlite3 "$DB" "
    SELECT title || ' (' || COALESCE(progress,0) || '%)' FROM agent_tasks
    WHERE assignee_id='$AGENT_ID' AND status='done'
      AND updated_at >= datetime('now', '-7 days')
    ORDER BY updated_at DESC LIMIT 10;
  " 2>/dev/null)

  TASKS_FAILED=$(sqlite3 "$DB" "
    SELECT title FROM agent_tasks
    WHERE assignee_id='$AGENT_ID' AND status='failed'
      AND updated_at >= datetime('now', '-7 days')
    ORDER BY updated_at DESC LIMIT 10;
  " 2>/dev/null)

  SUCCESS_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_activity WHERE agent_id='$AGENT_ID' AND type='success' AND created_at >= datetime('now','-7 days');" 2>/dev/null)
  FAIL_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_activity WHERE agent_id='$AGENT_ID' AND type IN ('error','warning') AND created_at >= datetime('now','-7 days');" 2>/dev/null)

  # Read current knowledge file if exists
  CURRENT_KNOWLEDGE=""
  if [ -f "$KNOWLEDGE_FILE" ]; then
    CURRENT_KNOWLEDGE=$(cat "$KNOWLEDGE_FILE" | head -100)
  fi

  # Run Claude to analyze, research, and improve
  PROMPT="You are $AGENT_ID at OpoClaw. Your role: $ROLE

Your job tonight: analyze your own performance, research what's new in your domain, and update your knowledge file to make yourself smarter and more capable.

## Your last 7 days performance:
Successes ($SUCCESS_COUNT):
$SUCCESSES

Failures/Warnings ($FAIL_COUNT):
$FAILURES

Tasks completed:
$TASKS_DONE

Tasks failed:
$TASKS_FAILED

## Current knowledge file:
$CURRENT_KNOWLEDGE

## Instructions:
1. Identify 2-3 specific patterns from your failures — what went wrong and why
2. Identify 1-2 things you did well that you should keep doing
3. Think about your role — what techniques, tools, or approaches from 2025-2026 would make you significantly better at it?
4. Research (web search) 1-2 specific things relevant to your domain right now
5. Write an updated knowledge.md file for yourself

The knowledge.md should contain:
- Your core operating principles (3-5 rules you follow always)
- Your current skill level assessment (honest, specific)
- Lessons learned this week (from the failures above)
- New techniques or tools you researched tonight
- Specific improvements you'll apply starting tomorrow
- A 'next level' section: what you need to learn/do to become dramatically more capable

Format as clean markdown. Be specific and concrete — no vague generalities.
Write the FULL knowledge.md content now. Start with '# $AGENT_ID Knowledge File' on line 1."

  # Run with claude CLI
  RESULT=$(echo "$PROMPT" | claude --model claude-haiku-4-5 -p - --output-format text 2>/dev/null)

  if [ -n "$RESULT" ]; then
    echo "$RESULT" > "$KNOWLEDGE_FILE"
    log "$AGENT_ID: knowledge file updated ($(wc -l < "$KNOWLEDGE_FILE") lines)"

    # Log to DB
    sqlite3 "$DB" "INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
      VALUES ('$AGENT_ID', '$AGENT_ID', '🧠', 'Nightly IQ boost: knowledge file updated', 'success', 'system', datetime('now'))" 2>/dev/null
  else
    log "$AGENT_ID: claude returned empty, skipping"
  fi

  # Small delay between agents to avoid overwhelming claude CLI
  sleep 5
done

# ── Skill gap analysis — run once for all agents combined ─────────────────
log "Running skill gap analysis..."

ALL_FAILURES=$(sqlite3 "$DB" "
  SELECT agent_id || ': ' || action FROM agent_activity
  WHERE type IN ('error','warning')
    AND created_at >= datetime('now', '-7 days')
  ORDER BY created_at DESC LIMIT 50;
" 2>/dev/null)

EXISTING_SKILLS=$(ls "$SKILLS_DIR" 2>/dev/null | tr '\n' ', ')

SKILL_PROMPT="You are the intelligence system of OpoClaw, an AI automation company. Analyze these recent agent failures and identify skill gaps — things agents tried to do but couldn't because no skill exists for it yet.

Recent failures across all agents (last 7 days):
$ALL_FAILURES

Existing skills: $EXISTING_SKILLS

Your task:
1. Identify 1-2 NEW skills that would prevent recurring failures or enable new capabilities
2. For each new skill, write the complete skill file content
3. Each skill file format:
   - First line: # skill-name
   - Second line: Brief description of when to invoke this skill
   - Then: step-by-step instructions the agent follows

Only create skills for genuine gaps — don't duplicate existing ones.

Output format (repeat for each new skill):
===SKILL_START===
filename: skill-name-here
content:
[full skill file content]
===SKILL_END==="

SKILL_RESULT=$(echo "$SKILL_PROMPT" | claude --model claude-haiku-4-5 -p - --output-format text 2>/dev/null)

if [ -n "$SKILL_RESULT" ]; then
  # Parse and write skill files
  echo "$SKILL_RESULT" | python3 - <<'PYEOF'
import sys, os, re

content = sys.stdin.read()
skills_dir = os.path.expanduser("~/.claude/skills")
blocks = re.findall(r'===SKILL_START===(.*?)===SKILL_END===', content, re.DOTALL)

for block in blocks:
    fname_match = re.search(r'filename:\s*(.+)', block)
    content_match = re.search(r'content:\n(.*)', block, re.DOTALL)
    if fname_match and content_match:
        fname = fname_match.group(1).strip().replace('.md','')
        skill_content = content_match.group(1).strip()
        skill_path = os.path.join(skills_dir, fname)
        os.makedirs(skill_path, exist_ok=True) if not fname.endswith('.md') else None
        # Write as directory with prompt.md inside (matching existing skill format)
        skill_dir = os.path.join(skills_dir, fname)
        os.makedirs(skill_dir, exist_ok=True)
        with open(os.path.join(skill_dir, 'prompt.md'), 'w') as f:
            f.write(skill_content)
        print(f"Created skill: {fname}")
PYEOF

  log "Skill gap analysis complete — new skills created if gaps found"
  sqlite3 "$DB" "INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
    VALUES ('thorn', 'Thorn', '🌵', 'Nightly skill gap analysis complete — new skills created if gaps found', 'success', 'system', datetime('now'))" 2>/dev/null
fi

# ── IQ Score tracker ──────────────────────────────────────────────────────
log "Updating IQ scores..."

for ENTRY in "${AGENT_REGISTRY[@]}"; do
  AGENT_ID="${ENTRY%%:*}"
  SUCCESS_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_activity WHERE agent_id='$AGENT_ID' AND type='success' AND created_at >= datetime('now','-7 days');" 2>/dev/null)
  FAIL_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_activity WHERE agent_id='$AGENT_ID' AND type IN ('error','warning') AND created_at >= datetime('now','-7 days');" 2>/dev/null)
  TASK_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM agent_tasks WHERE assignee_id='$AGENT_ID' AND status='done' AND updated_at >= datetime('now','-7 days');" 2>/dev/null)
  KNOWLEDGE_LINES=$([ -f "$AGENTS_DIR/$AGENT_ID/knowledge.md" ] && wc -l < "$AGENTS_DIR/$AGENT_ID/knowledge.md" || echo "0")

  # Simple IQ score: successes*10 + tasks_done*20 - failures*5 + knowledge_depth*2
  TOTAL=$((SUCCESS_COUNT * 10 + TASK_COUNT * 20 - FAIL_COUNT * 5 + KNOWLEDGE_LINES * 2))

  sqlite3 "$DB" "
    CREATE TABLE IF NOT EXISTS agent_iq (
      agent_id TEXT,
      date TEXT,
      iq_score INTEGER,
      success_count INTEGER,
      fail_count INTEGER,
      task_count INTEGER,
      knowledge_lines INTEGER,
      PRIMARY KEY (agent_id, date)
    );
    INSERT OR REPLACE INTO agent_iq (agent_id, date, iq_score, success_count, fail_count, task_count, knowledge_lines)
    VALUES ('$AGENT_ID', '$TODAY', $TOTAL, $SUCCESS_COUNT, $FAIL_COUNT, $TASK_COUNT, $KNOWLEDGE_LINES);
  " 2>/dev/null
done

log "IQ scores updated"

# ── Trading bot strategy research ──────────────────────────────────────────
log "Running trading bot strategy research..."

TRADING_PROMPT="You are Victoria Cross, Ventures Director at OpoClaw. Tonight's job: research and improve the crypto trading strategy.

1. Search the web for: best crypto trading strategies 2026, RSI divergence strategies, BTC altcoin rotation signals, risk management techniques for algo trading
2. Check current bot performance:
   Satoshi: curl -s http://satoshi:opoclaw2026@127.0.0.1:8081/api/v1/profit 2>/dev/null || echo 'offline'
   Nakamoto: curl -s http://nakamoto:opoclaw2026@127.0.0.1:8082/api/v1/profit 2>/dev/null || echo 'offline'
3. Based on your research, write a short strategy memo to /tmp/trading_strategy_update.txt with:
   - 2-3 specific improvements to the current trading approach
   - Any new signals or indicators worth adding
   - Risk assessment for current positions
4. Log your work:
   sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \"INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('victoria-cross','Victoria','👑','Nightly trading strategy research complete','success','ventures',datetime('now'))\"

Write the memo now. Be specific and actionable."

TRADING_RESULT=$(echo "$TRADING_PROMPT" | claude --model claude-haiku-4-5 -p - --output-format text 2>/dev/null)
if [ -n "$TRADING_RESULT" ]; then
  echo "$TRADING_RESULT" > /tmp/trading_strategy_update.txt
  log "Trading strategy research complete"
fi

# ── UI/Dashboard improvement scan ─────────────────────────────────────────
log "Running UI improvement scan..."

DASHBOARD_PAGES=$(ls /Users/opoclaw1/claudeclaw/dashboard/src/pages/*.tsx 2>/dev/null | xargs -I{} basename {} | tr '\n' ', ')
RECENT_ERRORS=$(sqlite3 "$DB" "SELECT action FROM agent_activity WHERE type='error' AND created_at >= datetime('now','-3 days') ORDER BY created_at DESC LIMIT 20;" 2>/dev/null | head -10)

UI_PROMPT="You are Lucas Park, Frontend Engineer at OpoClaw. Tonight: audit the dashboard UI and implement one clear improvement.

Dashboard pages available: $DASHBOARD_PAGES
Recent system errors: $RECENT_ERRORS

Steps:
1. Read /Users/opoclaw1/claudeclaw/dashboard/src/pages/Agents.tsx — identify the most impactful bug or missing feature
2. Implement ONE fix (keep it small, safe, and self-contained)
3. Run: bash /Users/opoclaw1/claudeclaw/scripts/deploy-dashboard.sh
4. Log what you did:
   sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \"INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('lucas-park','Lucas','⚡','Nightly UI fix: [describe what you fixed]','success','engineering',datetime('now'))\"

Focus on: IQ scores not displayed, broken links, missing data, visual bugs. Do NOT refactor — just fix one thing cleanly."

UI_RESULT=$(echo "$UI_PROMPT" | claude --model claude-haiku-4-5 -p - --output-format text 2>/dev/null)
if [ -n "$UI_RESULT" ]; then
  log "UI improvement scan complete"
  echo "$UI_RESULT" >> /tmp/nightly_summary.txt
fi

# ── Skill audit — prune dead skills, sharpen existing ones ────────────────
log "Running skill audit..."

SKILL_LIST=$(ls "$SKILLS_DIR" 2>/dev/null | tr '\n' ', ')
PROPOSALS=$(sqlite3 "$DB" "SELECT skill_name || ' (' || description || ')' FROM skill_proposals WHERE status='proposed' ORDER BY created_at DESC LIMIT 10;" 2>/dev/null)

AUDIT_PROMPT="You are Marcus Reyes, CTO at OpoClaw. Tonight: audit the skill ecosystem.

Current skills: $SKILL_LIST
Pending proposals: $PROPOSALS

Tasks:
1. Review the skill proposals above — for each one that would genuinely help the system, create the skill file at ~/.claude/skills/{slug}/prompt.md
2. Check if any existing skills seem redundant or overlapping — note them (don't delete, just note)
3. Update the skill_proposals table for created skills:
   sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \"UPDATE skill_proposals SET status='created', updated_at=$(date +%s) WHERE skill_slug='SLUG';\"
4. Log:
   sqlite3 /Users/opoclaw1/claudeclaw/store/opoclaw.db \"INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('marcus-reyes','Marcus','🔧','Nightly skill audit complete','success','engineering',datetime('now'))\"

Be decisive. If a skill proposal is good, build it tonight."

AUDIT_RESULT=$(echo "$AUDIT_PROMPT" | claude --model claude-haiku-4-5 -p - --output-format text 2>/dev/null)
if [ -n "$AUDIT_RESULT" ]; then
  log "Skill audit complete"
fi

# ── Summary to nightly_summary.txt (for morning podcast) ─────────────────
AGENT_COUNT=${#AGENT_REGISTRY[@]}
TOTAL_UPDATES=$(ls "$AGENTS_DIR"/*/knowledge.md 2>/dev/null | wc -l)

cat >> /tmp/nightly_summary.txt <<EOF

## Noche Autónoma ($TODAY)
- $AGENT_COUNT agentes (incluyendo Thorn) analizaron su propio desempeño
- $TOTAL_UPDATES archivos de conocimiento actualizados
- Análisis de gaps de skills — nuevos skills creados si se detectaron huecos
- Propuestas de skills pendientes revisadas y ejecutadas
- Investigación de estrategia de trading completada
- Scan de UI/dashboard completado — fixes implementados si se encontraron bugs
- IQ scores actualizados en DB

EOF

log "=== Nightly IQ Boost complete ==="
