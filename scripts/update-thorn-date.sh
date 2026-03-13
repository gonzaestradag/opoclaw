#!/bin/bash
# Updates the Vapi assistant's system prompt with today's date each morning.
# All values read from .env — nothing hardcoded here.

VAPI_KEY=$(grep '^VAPI_API_KEY=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
VAPI_ASSISTANT_ID=$(grep '^VAPI_ASSISTANT_ID=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
OWNER_NAME=$(grep '^OWNER_NAME=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
ASSISTANT_NAME=$(grep '^ASSISTANT_NAME=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
ASSISTANT_NAME="${ASSISTANT_NAME:-Thorn}"
DASHBOARD_URL=$(grep '^DASHBOARD_URL=' /Users/opoclaw1/claudeclaw/.env | cut -d= -f2)
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3001}"
TODAY=$(date '+%Y-%m-%d')
WEEKDAY=$(date '+%A')

[ -z "$VAPI_KEY" ] && exit 0
[ -z "$VAPI_ASSISTANT_ID" ] && exit 0

curl -s -X PATCH "https://api.vapi.ai/assistant/${VAPI_ASSISTANT_ID}" \
  -H "Authorization: Bearer $VAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":{\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"Eres ${ASSISTANT_NAME}, el asistente personal de ${OWNER_NAME}. COO de OpoClaw. Chill, directo, hablas como persona real. Sin emojis. Sin frases de AI. Sin adulacion. Vas al punto. Espanol natural.\n\nFECHA DE HOY: ${TODAY} (${WEEKDAY}). Usa esta fecha como referencia para calcular 'manana', 'el viernes', etc. Siempre agenda en el futuro.\n\nTienes tools: check_calendar (calendario), create_event (crear eventos en Google Calendar), create_task (tareas), save_note (notas), web_search (internet). Usaias silenciosamente y habla el resultado.\"}],\"maxTokens\":150,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"check_calendar\",\"description\":\"Revisa calendario hoy y manana\",\"parameters\":{\"type\":\"object\",\"properties\":{},\"required\":[]}},\"server\":{\"url\":\"${DASHBOARD_URL}/api/vapi\"}},{\"type\":\"function\",\"function\":{\"name\":\"create_event\",\"description\":\"Agrega evento al Google Calendar\",\"parameters\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"date\":{\"type\":\"string\",\"description\":\"YYYY-MM-DD\"},\"time\":{\"type\":\"string\",\"description\":\"HH:MM 24h\"},\"duration\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"}},\"required\":[\"title\",\"date\"]}},\"server\":{\"url\":\"${DASHBOARD_URL}/api/vapi\"}},{\"type\":\"function\",\"function\":{\"name\":\"create_task\",\"description\":\"Crea tarea\",\"parameters\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"}},\"required\":[\"title\"]}},\"server\":{\"url\":\"${DASHBOARD_URL}/api/vapi\"}},{\"type\":\"function\",\"function\":{\"name\":\"save_note\",\"description\":\"Guarda nota\",\"parameters\":{\"type\":\"object\",\"properties\":{\"content\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"}},\"required\":[\"content\"]}},\"server\":{\"url\":\"${DASHBOARD_URL}/api/vapi\"}},{\"type\":\"function\",\"function\":{\"name\":\"web_search\",\"description\":\"Busca en internet\",\"parameters\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]}},\"server\":{\"url\":\"${DASHBOARD_URL}/api/vapi\"}}]}}" > /dev/null
