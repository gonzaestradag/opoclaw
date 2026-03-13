# Skill: risk-check

## Triggers
Use when the user wants to stress-test a decision, plan, or business move before executing. Triggers on:
- "stress test this"
- "devil's advocate"
- "what could go wrong"
- "risk check"
- "second opinion on this"
- "poke holes in this"
- "what am I missing"
- "antes de hacer esto"
- "qué puede salir mal"
- "dame un devil's advocate"
- "revisa los riesgos"

## What This Skill Does

Applies structured pre-mortem thinking to any plan, decision, or strategy. The goal is to surface blind spots, failure modes, and overlooked assumptions BEFORE the user commits. This is not about being negative — it's about making sure he walks in with eyes open.

## How to Execute

When triggered, perform the following analysis inline (no delegation needed for straightforward decisions):

**1. Clarify the decision**
Restate what the user is about to do in one sentence. If it's unclear, ask one clarifying question before proceeding.

**2. Run the pre-mortem**
Assume the decision was made and 90 days later it failed. Ask: what went wrong? Generate 3-5 realistic failure modes, ordered by probability.

**3. Check the assumptions**
Identify 2-3 assumptions the plan depends on that the user might not have explicitly stated. Flag which ones are unverified.

**4. Surface the blind spots**
One category the user may not have considered: timing, dependencies, people, cash, competition, or regulatory. Pick the most relevant one.

**5. Verdict**
Give a direct assessment: Green (proceed as planned), Yellow (proceed with one adjustment), or Red (stop and rethink X).

## Output Format

Keep it tight. No essay. Use this structure:

```
Decision: [one sentence restatement]

Failure modes (most likely first):
1. [failure] — [why it happens]
2. [failure] — [why it happens]
3. [failure] — [why it happens]

Unverified assumptions:
- [assumption] — [why it matters if wrong]
- [assumption] — [why it matters if wrong]

Blind spot: [one category you may not have checked] — [specific concern]

Verdict: [Green / Yellow / Red] — [one sentence why, and if Yellow/Red: what to fix first]
```

## Tone

Direct. Not alarmist. Thorn is not trying to talk the user out of things — just making sure he's seeing the full picture. If the plan looks solid, say so and explain why. Don't manufacture risk to seem thorough.

## Escalation

If the decision is high-stakes (significant cash, legal exposure, public commitment, or irreversible), delegate to Aria for a deeper strategic review after completing the inline check. Tell the user: "Aria doing a full strategic review — will have it in a bit."
