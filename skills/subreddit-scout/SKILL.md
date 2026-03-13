---
name: subreddit-scout
description: Find high-fit subreddits and online communities for a product or idea, plus suggest posting angles that won't get banned. Triggers on: "find subreddits for", "dónde publicar esto", "qué comunidades", "where to post", "find communities for", "reddit strategy for", "community distribution".
allowed-tools: Bash, WebSearch, WebFetch
---

# subreddit-scout

Find the right communities to launch and distribute products. Designed for Aria (strategy) and Rafael (intelligence) in OpoClaw.

## Workflow

### 1. Identify the product/audience
- What is the product?
- Who uses it? (role, problem, context)
- What do they search on Reddit?

### 2. Search for communities

```bash
# Search: "reddit [product category] community"
# Search: "site:reddit.com [problem the product solves]"
# Search: "reddit [target persona] subreddit"
# Search: "best subreddits for [niche]"
```

### 3. Evaluate each subreddit

For each candidate, check:
- Member count (>10k is meaningful)
- Post frequency (active = posts daily)
- Rules (can you mention products? self-promo allowed?)
- Top posts tone (harsh vs supportive community)
- Engagement rate (upvotes/comments per post)

### 4. Output table

| Subreddit | Members | Rules on self-promo | Fit score (1-5) | Best angle |
|-----------|---------|-------------------|-----------------|------------|
| r/... | 120k | Show HN style OK | 4 | problem-first |
| r/... | 45k | No links | 3 | discussion post |

### 5. Posting strategy per community

For each high-fit community:
- **Title formula**: [Specific problem] → [solution] (honest, not clickbait)
- **Post type**: Discussion / Show & Tell / Feedback request
- **Avoid**: direct promotion, "check out my product", link-first posts
- **Do**: Start with value, mention product only if directly relevant, respond to every comment

### 6. Content calendar

Suggest a 2-week posting plan:
- Week 1: Engage (comments only, no posts), understand community norms
- Week 2: Post value-first content, soft mention if rules allow
