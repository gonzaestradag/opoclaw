---
name: social-scheduler
description: Schedule and manage social media posts across multiple platforms. Triggers on: "programa un post", "schedule this for", "publica en LinkedIn", "post to Twitter", "schedule content", "publica esto en", "haz un post para", "social media schedule".
allowed-tools: Bash, WebFetch
---

# social-scheduler

Schedule content across 10+ platforms via Publora API or native APIs. Designed for Sofia (content) in OpoClaw.

## Supported platforms

Via Publora (publora.com API):
- X/Twitter, LinkedIn, Instagram, Threads, Facebook, Bluesky, Mastodon, TikTok

## Required inputs

1. Content (text, optional image)
2. Platform(s)
3. Publish time (specific datetime or "now")
4. Any hashtags or mentions

## Workflow

### Option 1: Publora (multi-platform, one API)

```bash
# POST to Publora API to schedule
# Requires PUBLORA_API_KEY in environment

CONTENT="Your post content here"
PLATFORM="twitter,linkedin"
SCHEDULE_AT="2026-03-06T10:00:00Z"

curl -s -X POST https://api.publora.com/v1/posts \
  -H "Authorization: Bearer $PUBLORA_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"content\": \"$CONTENT\",
    \"platforms\": [\"$PLATFORM\"],
    \"scheduledAt\": \"$SCHEDULE_AT\"
  }" | python3 -m json.tool
```

### Option 2: Draft-only (no API key needed)

When no API key is available, produce formatted drafts:

```
PLATFORM: LinkedIn
POST: [full text, max 3000 chars]
SCHEDULE: [date + time]
HASHTAGS: [3-5 relevant]
---
PLATFORM: X/Twitter
POST: [max 280 chars — punchy version]
SCHEDULE: same
```

## Content guidelines per platform

- **LinkedIn**: Professional, insight-driven, 150-400 words, personal story > corporate speak
- **X/Twitter**: Under 240 chars, hook in first 5 words, one idea only
- **Instagram**: Visual description first, caption second, 5-10 hashtags
- **Threads**: Conversational, under 300 chars, works standalone

## Apply brand voice

Before publishing any content, run it through the `humanize` skill to strip AI patterns.

## Log activity

```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('sofia-ramos','Sofia','📚','Scheduled social media content','success','content',datetime('now'))"
```
