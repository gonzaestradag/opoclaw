#!/bin/bash
# Update Vapi assistant server URL and all tool URLs to current tunnel URL
# Supports: Cloudflare Tunnel (primary), ngrok (fallback)

VAPI_KEY=$(grep VAPI_API_KEY /Users/opoclaw1/claudeclaw/.env | cut -d= -f2 | tr -d '"' | tr -d ' ')
ASSISTANT_ID=$(grep VAPI_ASSISTANT_ID /Users/opoclaw1/claudeclaw/.env | cut -d= -f2 | tr -d '"' | tr -d ' ')

# Priority 1: Read DASHBOARD_URL from .env (set by cloudflare-tunnel.sh on start)
TUNNEL_URL=$(grep "^DASHBOARD_URL=" /Users/opoclaw1/claudeclaw/.env | cut -d= -f2 | tr -d '"' | tr -d ' ')

# Priority 2: Read from cloudflared URL cache file
if [ -z "$TUNNEL_URL" ] && [ -f /tmp/cloudflared-url.txt ]; then
  TUNNEL_URL=$(cat /tmp/cloudflared-url.txt)
fi

# Priority 3: Fall back to ngrok API (legacy)
if [ -z "$TUNNEL_URL" ]; then
  TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); urls=[t['public_url'] for t in d.get('tunnels',[]) if 'https' in t['public_url']]; print(urls[0] if urls else '')" 2>/dev/null)
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "No tunnel URL found (tried .env, /tmp/cloudflared-url.txt, ngrok API) — skipping"
  exit 1
fi

TOOL_URL="$TUNNEL_URL/api/vapi"
INBOUND_URL="$TUNNEL_URL/api/vapi/inbound"

echo "Updating Vapi assistant serverUrl to: $INBOUND_URL"
echo "Updating all tool server URLs to: $TOOL_URL"

RESULT=$(curl -s -X PATCH "https://api.vapi.ai/assistant/$ASSISTANT_ID" \
  -H "Authorization: Bearer $VAPI_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"serverUrl\": \"$INBOUND_URL\",
    \"server\": {\"url\": \"$INBOUND_URL\", \"timeoutSeconds\": 20},
    \"model\": {
      \"tools\": [
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":25},\"function\":{\"name\":\"check_calendar\",\"description\":\"Consulta los eventos del calendario de Gonzalo para hoy y mañana\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":25},\"function\":{\"name\":\"create_event\",\"description\":\"Agenda un evento en el Google Calendar de Gonzalo\",\"parameters\":{\"type\":\"object\",\"required\":[\"title\",\"date\"],\"properties\":{\"title\":{\"type\":\"string\"},\"date\":{\"type\":\"string\"},\"time\":{\"type\":\"string\"},\"duration\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"}}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":35},\"function\":{\"name\":\"web_search\",\"description\":\"Busca informacion actualizada en internet sobre noticias, precios, datos actuales\",\"parameters\":{\"type\":\"object\",\"required\":[\"query\"],\"properties\":{\"query\":{\"type\":\"string\"}}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":35},\"function\":{\"name\":\"make_call\",\"description\":\"Hace una llamada telefonica saliente en nombre de Gonzalo\",\"parameters\":{\"type\":\"object\",\"required\":[\"phone_number\",\"task\"],\"properties\":{\"phone_number\":{\"type\":\"string\"},\"task\":{\"type\":\"string\"},\"create_event_on_success\":{\"type\":\"string\"},\"event_title\":{\"type\":\"string\"},\"event_date\":{\"type\":\"string\"},\"event_time\":{\"type\":\"string\"}}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":20},\"function\":{\"name\":\"lookup_contact\",\"description\":\"Busca un contacto en la agenda de Gonzalo\",\"parameters\":{\"type\":\"object\",\"required\":[\"name\"],\"properties\":{\"name\":{\"type\":\"string\"}}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":20},\"function\":{\"name\":\"create_task\",\"description\":\"Crea una tarea en el tablero de OpoClaw\",\"parameters\":{\"type\":\"object\",\"required\":[\"title\"],\"properties\":{\"title\":{\"type\":\"string\"},\"description\":{\"type\":\"string\"},\"assignee\":{\"type\":\"string\"}}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":20},\"function\":{\"name\":\"save_note\",\"description\":\"Guarda una nota en BrainVault\",\"parameters\":{\"type\":\"object\",\"required\":[\"content\"],\"properties\":{\"title\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":20},\"function\":{\"name\":\"send_telegram\",\"description\":\"Envia un mensaje de texto a Gonzalo por Telegram\",\"parameters\":{\"type\":\"object\",\"required\":[\"message\"],\"properties\":{\"message\":{\"type\":\"string\"}}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":30},\"function\":{\"name\":\"read_emails\",\"description\":\"Lee los ultimos emails sin leer de Gonzalo en Gmail\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},
        {\"type\":\"function\",\"server\":{\"url\":\"$TOOL_URL\",\"timeoutSeconds\":15},\"function\":{\"name\":\"delegate_to_thorn\",\"description\":\"Delega cualquier tarea compleja al equipo de agentes de OpoClaw\",\"parameters\":{\"type\":\"object\",\"required\":[\"instruction\"],\"properties\":{\"instruction\":{\"type\":\"string\"}}}}}
      ]
    }
  }")

UPDATED_URL=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('serverUrl','error'))" 2>/dev/null)
TOOL_COUNT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('model',{}).get('tools',[])))" 2>/dev/null)
echo "Done. serverUrl set to: $UPDATED_URL | tools updated: $TOOL_COUNT"
