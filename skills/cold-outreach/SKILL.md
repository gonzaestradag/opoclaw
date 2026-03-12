---
name: cold-outreach
description: Generate high-converting cold outreach sequences for email, LinkedIn DM, or WhatsApp. Triggers on: "escribe un cold email", "cold outreach", "mensaje de prospección", "contacta a leads", "secuencia de emails", "write outreach for", "pitch to", "reach out to".
allowed-tools: Bash
---

# cold-outreach

Generate hyper-personalized, high-converting cold outreach using proven frameworks (Hormozi, Brunson, Bly). Designed for Sofia (content) and Aria (strategy) in OpoClaw.

## Triggers

Use when Gonzalo wants to reach out to potential clients, partners, investors, or collaborators.

## Frameworks available

- **Hormozi Value Equation**: Outcome * Likelihood / Time * Effort — make the offer irresistible
- **PAS**: Problem → Agitate → Solution
- **AIDA**: Attention → Interest → Desire → Action
- **Straight line**: One clear value prop, one clear next step, no detours

## Required inputs (ask if not given)

1. Who are we reaching out to? (role, company type, context)
2. What's the offer / what do we want them to do?
3. Channel: email / LinkedIn DM / WhatsApp?
4. Any personalization info about this specific person/company?

## Output

Produce a 3-message sequence:
- **Message 1**: First touch — short, curiosity-driven, one CTA
- **Message 2**: Follow-up day 3-5 — add value, different angle
- **Message 3**: Break-up day 10 — permission to say no, keeps door open

Each message: subject line (if email), body, max 150 words.

## Quality rules

- No em dashes
- No "I hope this finds you well" or any cliché opener
- Lead with THEIR problem, not our product
- One CTA per message, maximum
- Sound like a person, not a company

## Save as file option

If Gonzalo wants to save the sequence:
```bash
cat > /tmp/outreach-$(date +%Y%m%d).md << 'CONTENT'
[sequence here]
CONTENT
echo "Saved to /tmp/outreach-$(date +%Y%m%d).md"
```
