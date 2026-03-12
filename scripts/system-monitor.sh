#!/bin/bash
# system-monitor.sh — silent system health check
# Only notifies when there is a problem (and whether it was resolved or not)

DB_PATH="/Users/opoclaw1/claudeclaw/store/claudeclaw.db"
TG_NOTIFY="/Users/opoclaw1/claudeclaw/scripts/tg-notify.sh"
PROBLEM_FILE="/tmp/sysmon-last-problem.txt"
PROBLEMS=()
RESOLVED=()

# --- PM2 CHECK ---
PM2_STATUS=$(pm2 jlist 2>/dev/null)
if [ -z "$PM2_STATUS" ]; then
  PROBLEMS+=("PM2 no responde")
else
  # Check for stopped/errored processes
  # Exclude cron-mode processes — 'stopped' is their expected state after execution
  STOPPED=$(echo "$PM2_STATUS" | python3 -c "
import sys, json
procs = json.load(sys.stdin)
bad = []
for p in procs:
    env = p.get('pm2_env', {})
    status = env.get('status', '')
    is_cron = bool(env.get('cron_restart'))
    # Cron jobs are supposed to be stopped between runs — ignore them
    if is_cron and status == 'stopped':
        continue
    if status not in ('online', 'one-launch-status', 'waiting restart'):
        bad.append(p['name'])
print('\n'.join(bad))
" 2>/dev/null)
  
  if [ -n "$STOPPED" ]; then
    while IFS= read -r proc_name; do
      [ -z "$proc_name" ] && continue
      # Try to restart it
      pm2 restart "$proc_name" > /dev/null 2>&1
      sleep 3
      NEW_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
procs = json.load(sys.stdin)
p = next((x for x in procs if x['name'] == '$proc_name'), None)
print(p.get('pm2_env', {}).get('status', 'unknown') if p else 'not_found')
" 2>/dev/null)
      
      if [ "$NEW_STATUS" = "online" ]; then
        RESOLVED+=("PM2: $proc_name reiniciado y online")
        sqlite3 "$DB_PATH" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('silas-vane','Silas','🔧','Monitor: $proc_name caido, reiniciado exitosamente','success','engineering',datetime('now'))"
      else
        PROBLEMS+=("PM2: $proc_name caido (status: $NEW_STATUS)")
        sqlite3 "$DB_PATH" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('silas-vane','Silas','🔧','Monitor: $proc_name caido y no se pudo reiniciar','error','engineering',datetime('now'))"
      fi
    done <<< "$STOPPED"
  fi
fi

# --- DISK CHECK ---
DISK_PCT=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$DISK_PCT" -ge 90 ]; then
  PROBLEMS+=("Disco al ${DISK_PCT}% de capacidad")
  sqlite3 "$DB_PATH" "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('silas-vane','Silas','🔧','Monitor: disco al ${DISK_PCT}%','warning','engineering',datetime('now'))"
fi

# --- MEMORY CHECK ---
MEM_PRESSURE=$(memory_pressure 2>/dev/null | grep "System memory pressure" | awk '{print $NF}' | tr -d '%' | tr -d '.')
# macOS: check if swap is being used heavily via vm_stat
SWAP_USED=$(sysctl vm.swapusage 2>/dev/null | awk '{print $7}' | tr -d 'M')
if [ -n "$SWAP_USED" ] && [ "${SWAP_USED%.*}" -gt 2000 ] 2>/dev/null; then
  PROBLEMS+=("Memoria: swap al ${SWAP_USED}MB (presion alta)")
fi

# --- DASHBOARD API CHECK ---
API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3001/api/agents 2>/dev/null)
if [ "$API_STATUS" != "200" ]; then
  PROBLEMS+=("Dashboard API no responde (HTTP $API_STATUS)")
fi

# --- EVALUATE AND NOTIFY ---
if [ ${#PROBLEMS[@]} -eq 0 ] && [ ${#RESOLVED[@]} -eq 0 ]; then
  # All good — exit silently, no message ever when nothing happened
  rm -f "$PROBLEM_FILE"
  exit 0
fi

# Something happened — build the notification
MSG_PARTS=()
for r in "${RESOLVED[@]}"; do
  MSG_PARTS+=("$r (resuelto)")
done
for p in "${PROBLEMS[@]}"; do
  MSG_PARTS+=("$p (requiere atencion)")
  echo "$p" >> "$PROBLEM_FILE"
done

SUMMARY=$(IFS=', '; echo "${MSG_PARTS[*]}")

# Only notify when there's an active problem OR when something was auto-fixed
if [ ${#PROBLEMS[@]} -gt 0 ]; then
  bash "$TG_NOTIFY" "Problema en el sistema: $SUMMARY. Requiere atencion."
elif [ ${#RESOLVED[@]} -gt 0 ]; then
  bash "$TG_NOTIFY" "Monitor arreglo un problema: $SUMMARY."
  rm -f "$PROBLEM_FILE"
fi
