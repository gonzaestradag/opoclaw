---
name: brand-voice
description: Store and apply a consistent brand voice profile for all content. Triggers on: "brand voice", "voz de marca", "escribe en el tono de", "mantén el estilo", "aplica nuestra voz", "write in our style", "tone guide".
allowed-tools: Bash
---

# brand-voice

Define, save, and apply a consistent brand voice across all content. Designed for Sofia (content) in OpoClaw.

## Brand Voice Profile — YOUR_BRAND

Stored at: `${REPO_DIR}/workspace/brand-voice.md`

### Tone
- Direct, confident, no fluff
- Talks like a founder/operator, not a marketer
- Casual but sharp — not corporate, not bro
- Spanish and English fluency — switches naturally

### Rules (non-negotiable)
- No em dashes
- No "certainly", "great question", "as an AI"
- No passive voice when active is possible
- No filler: "In today's world...", "In this article we will..."
- Sentences: short. Max 20 words.
- Lead with the point, not the setup

### Voice descriptors
- Founder would say: "Esto ya funciona, lo siguiente es escalar."
- Not: "We are excited to announce that after months of hard work..."
- Founder would say: "Jordan watches every dollar. That's the point."
- Not: "Our financial management processes are robust and scalable."

## Usage

When writing any content (blog, LinkedIn, email, Telegram message), load this profile and apply it:

```bash
# Read current brand voice profile
cat ${REPO_DIR}/workspace/brand-voice.md 2>/dev/null || echo "No brand voice file yet — using defaults above"
```

## Update brand voice

If the user provides new examples or corrections:
```bash
cat >> ${REPO_DIR}/workspace/brand-voice.md << 'EOF'

## Update [DATE]
[new rule or example]
EOF
```
