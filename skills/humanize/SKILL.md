---
name: humanize
description: Strip AI writing patterns from text — em dashes, stock phrases, corporate fluff, performed authenticity. Triggers on: "humanize this", "hazlo sonar más humano", "quita el tono de AI", "suena muy robot", "make it sound natural", "edit this to sound like me", "less AI more human".
allowed-tools: Bash
---

# humanize

Remove AI writing patterns and make text sound like a real person wrote it. Critical for OpoClaw — every agent output that goes public must pass this filter.

## What to remove

- Em dashes (—) → use comma or period instead
- "Certainly!", "Great!", "Absolutely!" → delete entirely
- "In today's world..." / "In this article..." → start with the point
- "I hope this finds you well" → delete
- "As an AI language model..." → never
- Passive voice clusters → make active
- "It's worth noting that..." → say it directly
- Oxford-comma-heavy lists with parallel structure → vary them
- Overly neat 3-point structures → real thoughts aren't always tidy
- Performative hedges: "While it's true that...", "On the other hand..." → cut
- Filler transitions: "Furthermore", "Moreover", "Additionally" → cut or use "Also"

## What to add (OpoClaw voice)

- Short sentences. Like this.
- Direct claims: "This works." not "This approach has shown promise."
- Specificity: "3 clients in 2 weeks" not "rapid growth"
- Opinions when relevant: "This is the move." not "This could potentially be considered."
- Natural Spanish-English mixing if context is OpoClaw internal

## Process

```bash
# Take the text, apply these rules, return the cleaned version
# No tooling needed — just rewrite following the rules above
# Do NOT add commentary about what you changed
# Just return the cleaned text
```

## Quality check

After rewriting, scan for:
- Any em dash → replace
- Any "certainly/absolutely/great question" → delete
- Any sentence over 25 words → split it
- Any passive "was done by" → make active
- Any paragraph over 4 lines → break it up

Return only the cleaned text, no explanation.
