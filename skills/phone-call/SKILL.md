---
name: phone-call
description: Make AI phone calls using a cloned voice. Triggers on: "llama a", "llámale a", "habla con", "confirma la reserva", "call this place", "make a call to", "llama al restaurante", "márcale a".
allowed-tools: Bash
---

# phone-call

Make outbound AI phone calls using Vapi.ai with an ElevenLabs cloned voice.

## Workflow

1. **Resolve who to call** — if the user gives a name (person or place), NOT a number:
   - For a **person**: query contacts DB first:
     ```bash
     sqlite3 ${REPO_DIR}/store/opoclaw.db "SELECT name, phone FROM contacts WHERE name LIKE '%NAME%' LIMIT 3;"
     ```
   - For a **business/place**: search the web for the phone number using WebSearch tool
2. **Confirm before calling** — reply with just the name and what you'll say. Never show the number. Example:
   - "Marco a Azael para decirle que mañana no puedes."
   - "Llamo a La Paloma para reservar mesa para 4 esta noche a las 8."
3. **Make the call** once confirmed
4. **Report back** — just confirm the call was initiated. When the call ends, an automatic AI-generated voice note summarizes what was said and what was accomplished. No manual transcript check needed.

## Make a call

```bash
VAPI_KEY=$(grep VAPI_API_KEY ${REPO_DIR}/.env | cut -d= -f2)
PHONE_ID=$(grep VAPI_PHONE_NUMBER_ID ${REPO_DIR}/.env | cut -d= -f2)
VOICE_ID=$(grep ELEVENLABS_VOICE_ID ${REPO_DIR}/.env | cut -d= -f2)
TODAY=$(date '+%Y-%m-%d (%A)')

curl -s -X POST https://api.vapi.ai/call \
  -H "Authorization: Bearer $VAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"phoneNumberId\": \"$PHONE_ID\",
    \"customer\": { \"number\": \"+52XXXXXXXXXX\" },
    \"assistant\": {
      \"firstMessage\": \"Hola, buenas tardes.\",
      \"model\": {
        \"provider\": \"anthropic\",
        \"model\": \"claude-haiku-4-5-20251001\",
        \"messages\": [{
          \"role\": \"system\",
          \"content\": \"[SYSTEM PROMPT]\"
        }],
        \"maxTokens\": 300
      },
      \"voice\": {
        \"provider\": \"11labs\",
        \"voiceId\": \"$VOICE_ID\",
        \"stability\": 0.5,
        \"similarityBoost\": 0.75,
        \"model\": \"eleven_turbo_v2_5\"
      },
      \"transcriber\": {
        \"provider\": \"deepgram\",
        \"model\": \"nova-2\",
        \"language\": \"es\",
        \"endpointing\": 100
      },
      \"stopSpeakingPlan\": {
        \"numWords\": 2,
        \"voiceSeconds\": 0.2,
        \"backoffSeconds\": 1
      }
    }
  }"
```

## Normalizing phone numbers

Always convert to E.164 before calling:
- 10 digits → `+52XXXXXXXXXX`
- Already has +52 → use as is
- Strip spaces, dashes, parentheses

## System prompt template

```
Eres el asistente virtual de YOUR_NAME. Hoy es [TODAY].
REGLA OBLIGATORIA: Al inicio de CADA llamada, preséntate exactamente así:
"Hola, soy el asistente virtual de YOUR_NAME."
Nunca omitas esta presentación — ni en llamadas de seguimiento, ni con contactos conocidos.
Tu tarea: [TASK].
Habla en español natural y directo. Al terminar di exactamente lo que respondieron.
Si no contestan, deja un mensaje de voz breve con la presentación y el recado.
```

## Important behavioral rules

- Always introduce as "el asistente virtual de YOUR_NAME" — this is non-negotiable on every call
- If the person seems confused or doesn't believe it's an AI assistant, be transparent: "Sí, soy un asistente de IA."
- Keep calls short and purposeful — deliver the message, get a response, hang up
- If voicemail: leave the intro + message + ask them to call the user back

## Automatic result delivery

When a call ends, the system automatically:
1. Generates an AI summary of the transcript (GPT-4o-mini)
2. Synthesizes it as a voice note using the user's ElevenLabs voice
3. Sends the voice note directly to the user via Telegram

If TTS fails, it sends the text summary. If the call had no transcript (no answer, voicemail), it sends a plain status message.

**No manual follow-up needed.** the user gets the result the same way he gets any other Thorn response.

## Check call status (manual fallback)

```bash
VAPI_KEY=$(grep VAPI_API_KEY ${REPO_DIR}/.env | cut -d= -f2)
curl -s "https://api.vapi.ai/call/[CALL_ID]" -H "Authorization: Bearer $VAPI_KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status')); print(d.get('transcript','')[:500])"
```

## Notes

- Mexico numbers: +52 followed by 10 digits
- Voice settings: eleven_turbo_v2_5, stability 0.5, similarityBoost 0.75
- Voice ID: set ELEVENLABS_VOICE_ID in .env (your cloned voice)
- Contacts DB: sqlite3 ${REPO_DIR}/store/opoclaw.db (table: contacts)
- Always confirm by NAME before calling — never show the number to the user
