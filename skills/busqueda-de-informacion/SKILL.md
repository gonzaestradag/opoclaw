---
name: busqueda-de-informacion
description: General-purpose research and information gathering on any topic, technology, tool, concept, or market. Triggers on: "busca info sobre", "investiga", "qué es", "cómo funciona", "research", "find info about", "look into", "dame contexto sobre", "explícame", "qué hay sobre", "qué existe de", "busca ejemplos de", "find examples of", "qué opciones hay para".
allowed-tools: Bash, WebSearch, WebFetch
---

# busqueda-de-informacion

General-purpose deep research skill. Takes any topic and returns a structured, actionable intelligence brief. Designed for Rafael (intelligence) and Kaelen (research) in OpoClaw.

## Triggers

Use when Gonzalo or an agent needs to understand something: a technology, a product category, a concept, a market trend, specific tools, examples, or background context on any topic.

## Required input

- **Topic**: What to research (required)
- **Depth**: Quick scan or deep dive? (default: medium)
- **Angle**: Is there a specific lens? (e.g. "for OpoClaw dashboard", "as a business opportunity", "technical implementation") — if not given, cover all angles

## Workflow

### 1. Define search vectors

Before searching, split the topic into 3-5 distinct search angles:
- Definition / fundamentals: what it is
- Examples / players: who does this / what exists
- Technical / implementation: how it works
- Trends / recent news: what's happening now
- Community / opinions: what practitioners say (Reddit, HN, GitHub)

### 2. Execute searches

```bash
# Vector 1 — Core definition
# Search: "[topic] what is how it works 2026"

# Vector 2 — Examples and players
# Search: "[topic] examples best tools open source"
# Search: "site:github.com [topic]"

# Vector 3 — Community intelligence
# Search: "site:reddit.com [topic]"
# Search: "site:news.ycombinator.com [topic]"

# Vector 4 — Recent developments
# Search: "[topic] 2026 new trends latest"

# Vector 5 (if relevant) — OpoClaw angle
# Search: "[topic] AI agents dashboard" or "[topic] automation workflow"
```

### 3. Fetch key sources

WebFetch the 2-3 most relevant URLs found in step 2. Prioritize:
- Official documentation or product pages
- GitHub repos with good stars/activity
- Authoritative articles or comparisons

### 4. Synthesize

Compile all findings into the output format below. Do not pad. Every sentence should carry information.

## Output format

```
RESEARCH BRIEF: [TOPIC]
=======================
Date: [today]
Depth: [quick / medium / deep]

WHAT IT IS
----------
[2-3 sentences. Precise definition. No fluff.]

KEY PLAYERS / EXAMPLES
-----------------------
- [Name] — [what it does, why notable]
- [Name] — [what it does, why notable]
- [Name] — [what it does, why notable]
(min 3, max 8 depending on depth)

HOW IT WORKS (if technical)
----------------------------
[Bullet list of the core mechanism. Skip if not applicable.]

WHAT PEOPLE ARE SAYING
-----------------------
[1-2 observations from Reddit/HN/community. Honest signal, not marketing copy.]

TRENDS / WHAT'S HAPPENING NOW
------------------------------
[What's new, what's shifting, what's gaining momentum in 2026]

RELEVANT TO OPOCLAW
--------------------
[Concrete takeaway: what Gonzalo can use, steal, avoid, or build on. Be specific.]
```

## Depth modes

- **Quick** (< 2 min): 3 searches, top results only, brief output (~200 words)
- **Medium** (default, ~5 min): 5-6 searches + 1-2 fetches, full output format
- **Deep** (10+ min): 8+ searches, multiple fetches, expanded sections, saved to file

## Save output (medium/deep)

```bash
RESEARCH_FILE="/Users/opoclaw1/claudeclaw/workspace/research/$(date +%Y%m%d)-[topic-slug].md"
mkdir -p /Users/opoclaw1/claudeclaw/workspace/research
# Write the full brief to this file
echo "Saved: $RESEARCH_FILE"
```

## Save to Brain Vault (medium/deep always, quick on request)

After writing the research file, also save a summary card to the Brain Vault so Gonzalo can find it from the dashboard:

```bash
BRIEF_CONTENT="RESEARCH BRIEF: [TOPIC] — [DATE]\n\n[PASTE FULL BRIEF CONTENT HERE]"
TOPIC_SLUG="[topic-slug]"
RESEARCH_FILE="/Users/opoclaw1/claudeclaw/workspace/research/$(date +%Y%m%d)-${TOPIC_SLUG}.md"

# Save to brain_vault (fallback if API is down)
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO brain_vault (title, content, type, tags, file_path, starred, created_at) VALUES (
    'Research: [TOPIC]',
    '$(head -c 2000 "$RESEARCH_FILE" | sed "s/'/''/g")',
    'research',
    '[topic-slug],intelligence,research',
    '$RESEARCH_FILE',
    0,
    datetime('now')
  );" 2>/dev/null || echo "Brain vault save skipped (table schema may differ)"

# Try via API if server is running
curl -s -X POST http://localhost:3001/api/brain/vault \
  -H "Content-Type: application/json" \
  -d "{\"title\": \"Research: [TOPIC]\", \"content\": \"$(head -c 1000 "$RESEARCH_FILE" | python3 -c 'import sys; print(sys.stdin.read().replace("\"","\\\\\"").replace("\n","\\\\n"))')\", \"type\": \"research\", \"tags\": \"[topic-slug]\"}" \
  2>/dev/null || true
```

## Check existing research before re-running (avoid duplicate work)

```bash
# Always check if this topic was already researched
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "SELECT title, created_at FROM brain_vault WHERE title LIKE '%[TOPIC]%' AND type='research' ORDER BY created_at DESC LIMIT 3;" 2>/dev/null
# Also check the research folder
ls /Users/opoclaw1/claudeclaw/workspace/research/ 2>/dev/null | grep -i "[topic-keyword]" | tail -5
```

If a fresh brief exists (< 7 days old), return it directly instead of re-running all searches.

## Log to OpoClaw

```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('rafael-silva','Rafael','🔍','Research completado: [topic]','success','intelligence',datetime('now'))"
```
