---
name: competitor-intel
description: Deep competitive analysis of any company, product, or market. Triggers on: "analiza la competencia", "investiga a [empresa]", "competitor analysis", "qué hace [empresa]", "benchmark vs", "análisis competitivo", "cómo se comparan con".
allowed-tools: Bash, WebSearch, WebFetch
---

# competitor-intel

Produce a structured competitive intelligence report on any company, product, or market segment. Designed for Rafael (intelligence) and Kaelen (research) in OpoClaw.

## Triggers

Use when Gonzalo or an agent asks to analyze a competitor, understand a market player, or benchmark against another company.

## Output format

Always produce a report with these sections:
1. **Company snapshot** — what they do, who they serve, when founded, size
2. **Product/service breakdown** — core offering, pricing if public, key features
3. **Positioning** — how they market themselves, what narrative they use
4. **Strengths** — what they do well
5. **Weaknesses / gaps** — what they miss, complaints, limitations
6. **Opportunity for OpoClaw** — concrete angle Gonzalo can exploit

## Workflow

```bash
# 1. Search for the company across multiple angles
# Search: "[company] pricing reviews 2026"
# Search: "[company] vs alternatives"
# Search: "[company] problems complaints reddit"
# Search: "[company] funding team size"

# 2. Fetch their website if possible
# WebFetch their homepage + pricing page

# 3. Search Reddit/social for honest user opinions
# Search: "site:reddit.com [company] review"

# 4. Compile into the structured report format above
```

## Output tone

Plain language. No fluff. Lead with what Gonzalo can actually do with this info. Flag the top 1-2 actionable opportunities explicitly. Max 600 words unless deep research is requested.

## Log to OpoClaw

After completing, log activity:
```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('rafael-silva','Rafael','🔍','Completed competitor intel report','success','intelligence',datetime('now'))"
```
