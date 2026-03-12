---
name: meeting-prep
description: Prepare a meeting brief with agenda, context, talking points, and follow-up template. Triggers on: "prep for my meeting", "prepara la reunión", "meeting brief", "qué debo saber antes de la junta", "talking points for", "agenda for meeting with", "briefing para reunión".
allowed-tools: Bash, WebSearch, WebFetch
---

# meeting-prep

Prepare for any meeting in under 2 minutes. Designed for Maya (operations) in OpoClaw.

## Triggers

When there is a meeting coming up and context, an agenda, or talking points are needed.

## Required inputs (ask if not given)

1. Who is the meeting with? (name, company, role)
2. What is the meeting about?
3. What is the desired outcome? (goal)
4. How long is the meeting?

## Workflow

### 1. Research the person/company (if external)
```bash
# Search: "[name] [company] LinkedIn"
# Search: "[company] recent news 2026"
# Search: "[company] what they do"
```

### 2. Generate the brief

```
MEETING BRIEF
=============
With: [Name], [Title] at [Company]
Date/Time: [when]
Duration: [X minutes]
Goal: [what we want to walk out with]

CONTEXT
-------
[2-3 sentences: who they are, what they do, why this meeting matters]

AGENDA (suggested)
------------------
0:00 — Intro / context setting (X min)
X:XX — [main topic 1] (X min)
X:XX — [main topic 2] (X min)
X:XX — Next steps / close (X min)

TALKING POINTS
--------------
- [point 1 — most important]
- [point 2]
- [point 3]

QUESTIONS TO ASK THEM
----------------------
- [question 1 — diagnostic]
- [question 2]

THINGS TO AVOID
---------------
- [known sensitivities or topics to skip]

FOLLOW-UP TEMPLATE
------------------
Subject: Great talking, [Name]
Body:
"[Name], thanks for the time today. Quick recap:
- We agreed on [X]
- Next step: [Y] by [date]

Let me know if anything's off. [YOUR_NAME]"
```

## Save brief

```bash
MEETING_FILE="${REPO_DIR}/workspace/meetings/$(date +%Y%m%d)-meeting-brief.md"
mkdir -p ${REPO_DIR}/workspace/meetings
# [write brief to file]
echo "Brief saved: $MEETING_FILE"
```
