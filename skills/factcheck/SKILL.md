---
name: factcheck
description: Verify claims, statistics, and statements before publishing or presenting them. Triggers on: "fact check this", "verifica esto", "is this true", "check if this is accurate", "esto es real", "comprueba la fuente", "verify this stat", "¿es verdad que".
allowed-tools: Bash, WebSearch, WebFetch
---

# factcheck

Verify claims before they go out. Designed for Rafael (intelligence) and Kaelen (research) in OpoClaw. Nothing public until it's verified.

## Workflow

For each claim to verify:

1. **Search for the primary source**
   - Look for the original study, report, or official statement
   - Search: "[exact claim] source" or "[statistic] original study"

2. **Cross-reference**
   - Find 2+ independent sources confirming
   - Check date — is this still current?
   - Check context — is the stat being used correctly?

3. **Rate confidence**
   - Verified (2+ primary sources): CONFIRMED
   - Partially confirmed (secondary sources only): LIKELY TRUE — verify before using
   - Contradicted by sources: FALSE — do not use
   - Cannot find source: UNVERIFIED — treat as opinion

## Output format

```
CLAIM: "[exact claim]"
STATUS: CONFIRMED / LIKELY TRUE / FALSE / UNVERIFIED
SOURCE: [best source URL or citation]
NOTES: [any context, caveats, or corrections]
```

## Common checks

- Stats older than 2 years → flag for recency
- "Studies show..." without citation → unverified
- Round numbers (50%, 10x, etc.) → often approximate, find the original
- Single-source claims → flag, require second source

## Speed mode

If checking multiple claims quickly:
```bash
# List all claims
# Rate each 1-5 (5=most critical to verify)
# Verify highest-priority ones first
# Return summary table
```
