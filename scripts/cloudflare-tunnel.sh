#!/usr/bin/env bash
# cloudflare-tunnel.sh
# PM2-managed Cloudflare Named Tunnel for dashboard.opoclaw.com
# Uses permanent named tunnel — URL never changes on restart

TUNNEL_URL="https://dashboard.opoclaw.com"
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"

echo "[cloudflare-tunnel] Starting named tunnel opoclaw-dashboard → localhost:3001"
echo "[cloudflare-tunnel] Permanent URL: $TUNNEL_URL"

# Update DASHBOARD_URL in .env to permanent URL
if grep -q "^DASHBOARD_URL=" "$ENV_FILE"; then
  sed -i '' "s|^DASHBOARD_URL=.*|DASHBOARD_URL=$TUNNEL_URL|" "$ENV_FILE"
else
  echo "DASHBOARD_URL=$TUNNEL_URL" >> "$ENV_FILE"
fi

# Update Vapi webhooks with permanent URL (non-blocking)
(sleep 3 && bash /Users/opoclaw1/claudeclaw/scripts/update-vapi-urls.sh) &

# Restart dashboard-server so it picks up the permanent DASHBOARD_URL
(sleep 5 && pm2 restart dashboard-server --update-env) &

# Run the named tunnel (this is the long-running process PM2 manages)
/opt/homebrew/bin/cloudflared tunnel --config /Users/opoclaw1/.cloudflared/config.yml run opoclaw-dashboard
