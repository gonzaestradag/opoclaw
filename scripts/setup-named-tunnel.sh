#!/usr/bin/env bash
# setup-named-tunnel.sh
# Sets up a Cloudflare named tunnel called "opoclaw" for the OpoClaw stack.
# Replaces the quick tunnel (random URL) with a persistent URL.
#
# REQUIREMENTS:
#   - cloudflared must be installed (brew install cloudflare/cloudflare/cloudflared)
#   - You must own a domain added to your Cloudflare account
#   - Run `cloudflared tunnel login` FIRST if ~/.cloudflared/cert.pem does not exist
#
# USAGE:
#   bash /Users/opoclaw1/setup-named-tunnel.sh [--domain your-domain.com]
#
# WHAT IT DOES:
#   1. Checks cloudflared is installed and authenticated
#   2. Creates a named tunnel called "opoclaw" (if it doesn't exist)
#   3. Configures DNS routes:
#      - dashboard.YOUR_DOMAIN  → port 3001 (OpoClaw dashboard)
#      - api.YOUR_DOMAIN        → port 4000 (openclaw-gateway)
#   4. Writes ~/.cloudflared/config.yml
#   5. Updates .env with the permanent dashboard URL
#   6. Restarts cloudflared PM2 process to use named tunnel
#   7. Updates Vapi webhook URL to the permanent URL

set -e

# ── Config ─────────────────────────────────────────────────────────────────────
TUNNEL_NAME="opoclaw"
ENV_FILE="/Users/opoclaw1/claudeclaw/.env"
CLOUDFLARE_DIR="$HOME/.cloudflared"
PM2_PROCESS_NAME="cloudflared"
TUNNEL_SCRIPT="/Users/opoclaw1/claudeclaw/scripts/cloudflare-tunnel.sh"

# Parse --domain argument
DOMAIN=""
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift ;;
    *) echo "Unknown param: $1"; exit 1 ;;
  esac
  shift
done

echo ""
echo "=== OpoClaw Named Tunnel Setup ==="
echo ""

# ── Step 1: Check cloudflared is installed ─────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  echo "[ERROR] cloudflared not found. Install it:"
  echo "  brew install cloudflare/cloudflare/cloudflared"
  exit 1
fi
CLOUDFLARED_VERSION=$(cloudflared --version 2>&1 | head -1)
echo "[OK] cloudflared installed: $CLOUDFLARED_VERSION"

# ── Step 2: Check authentication ───────────────────────────────────────────────
if [ ! -f "$CLOUDFLARE_DIR/cert.pem" ]; then
  echo ""
  echo "[ACTION REQUIRED] Not authenticated with Cloudflare."
  echo ""
  echo "Run this command ONCE in your terminal (it opens a browser):"
  echo ""
  echo "  cloudflared tunnel login"
  echo ""
  echo "After logging in, a cert.pem will be saved to ~/.cloudflared/"
  echo "Then re-run this script."
  exit 1
fi
echo "[OK] Cloudflare authenticated (cert.pem found)"

# ── Step 3: Domain check ───────────────────────────────────────────────────────
if [ -z "$DOMAIN" ]; then
  # Try to detect domain from existing tunnels
  EXISTING_TUNNELS=$(cloudflared tunnel list 2>/dev/null || echo "")
  echo ""
  echo "Available tunnels:"
  echo "$EXISTING_TUNNELS"
  echo ""
  echo "Enter your Cloudflare domain (e.g. opoclaw.com):"
  read -r DOMAIN
fi

if [ -z "$DOMAIN" ]; then
  echo "[ERROR] Domain is required."
  exit 1
fi

DASHBOARD_HOSTNAME="dashboard.$DOMAIN"
GATEWAY_HOSTNAME="api.$DOMAIN"
DASHBOARD_URL="https://$DASHBOARD_HOSTNAME"

echo "[OK] Domain: $DOMAIN"
echo "     Dashboard URL: $DASHBOARD_URL"
echo "     Gateway URL:   https://$GATEWAY_HOSTNAME"

# ── Step 4: Create or reuse named tunnel ───────────────────────────────────────
echo ""
echo "[...] Checking for existing tunnel named '$TUNNEL_NAME'..."

EXISTING=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" || echo "")
if [ -n "$EXISTING" ]; then
  echo "[OK] Tunnel '$TUNNEL_NAME' already exists."
  TUNNEL_ID=$(echo "$EXISTING" | awk '{print $1}')
else
  echo "[...] Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
  echo "[OK] Created tunnel ID: $TUNNEL_ID"
fi

if [ -z "$TUNNEL_ID" ]; then
  echo "[ERROR] Could not determine tunnel ID. Run 'cloudflared tunnel list' to debug."
  exit 1
fi

echo "[OK] Tunnel ID: $TUNNEL_ID"

# ── Step 5: Write cloudflared config.yml ──────────────────────────────────────
mkdir -p "$CLOUDFLARE_DIR"
CONFIG_FILE="$CLOUDFLARE_DIR/config.yml"

echo ""
echo "[...] Writing $CONFIG_FILE..."

cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CLOUDFLARE_DIR/$TUNNEL_ID.json

ingress:
  # OpoClaw Dashboard
  - hostname: $DASHBOARD_HOSTNAME
    service: http://localhost:3001
    originRequest:
      connectTimeout: 10s
      noTLSVerify: false

  # OpoClaw Gateway (API)
  - hostname: $GATEWAY_HOSTNAME
    service: http://localhost:4000
    originRequest:
      connectTimeout: 10s
      noTLSVerify: false

  # Catch-all (required by cloudflared)
  - service: http_status:404
EOF

echo "[OK] Config written to $CONFIG_FILE"

# ── Step 6: Create DNS routes ──────────────────────────────────────────────────
echo ""
echo "[...] Setting up DNS routes (this may take a moment)..."

cloudflared tunnel route dns "$TUNNEL_NAME" "$DASHBOARD_HOSTNAME" 2>&1 || echo "[WARN] DNS route for $DASHBOARD_HOSTNAME may already exist — continuing"
cloudflared tunnel route dns "$TUNNEL_NAME" "$GATEWAY_HOSTNAME" 2>&1 || echo "[WARN] DNS route for $GATEWAY_HOSTNAME may already exist — continuing"

echo "[OK] DNS routes configured"

# ── Step 7: Update cloudflare-tunnel.sh to use named tunnel ───────────────────
echo ""
echo "[...] Updating PM2 tunnel script to use named tunnel..."

cat > "$TUNNEL_SCRIPT" <<'SCRIPT'
#!/usr/bin/env bash
# cloudflare-tunnel.sh
# PM2-managed wrapper — runs the OpoClaw named Cloudflare tunnel.
# Named tunnel = persistent URL, no random URLs on restart.

set -e

CONFIG_FILE="$HOME/.cloudflared/config.yml"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[cloudflare-tunnel] ERROR: config.yml not found at $CONFIG_FILE"
  echo "[cloudflare-tunnel] Run setup-named-tunnel.sh first."
  exit 1
fi

echo "[cloudflare-tunnel] Starting named tunnel (opoclaw)..."
exec cloudflared tunnel --config "$CONFIG_FILE" --no-autoupdate run
SCRIPT

chmod +x "$TUNNEL_SCRIPT"
echo "[OK] Tunnel script updated"

# ── Step 8: Update .env with permanent dashboard URL ──────────────────────────
echo ""
echo "[...] Updating DASHBOARD_URL in .env..."

if grep -q "^DASHBOARD_URL=" "$ENV_FILE"; then
  sed -i '' "s|^DASHBOARD_URL=.*|DASHBOARD_URL=$DASHBOARD_URL|" "$ENV_FILE"
else
  echo "DASHBOARD_URL=$DASHBOARD_URL" >> "$ENV_FILE"
fi

# Update the comment above DASHBOARD_URL to reflect named tunnel
sed -i '' "s|# Public URL for Vapi webhooks.*|# Public URL for Vapi webhooks and tool callbacks (Cloudflare Named Tunnel — persistent URL)|" "$ENV_FILE" 2>/dev/null || true

echo "[OK] DASHBOARD_URL set to $DASHBOARD_URL"

# ── Step 9: Restart cloudflared via PM2 ───────────────────────────────────────
echo ""
echo "[...] Restarting cloudflared PM2 process..."
pm2 restart "$PM2_PROCESS_NAME" --update-env 2>/dev/null || pm2 start "$TUNNEL_SCRIPT" --name "$PM2_PROCESS_NAME" --interpreter bash
pm2 save
echo "[OK] cloudflared restarted"

# ── Step 10: Update Vapi webhook URL ──────────────────────────────────────────
echo ""
echo "[...] Updating Vapi webhook URL to permanent URL..."
sleep 3
bash /Users/opoclaw1/claudeclaw/scripts/update-vapi-urls.sh
echo "[OK] Vapi updated"

# ── Step 11: Restart dashboard-server to pick up new .env ─────────────────────
echo ""
echo "[...] Restarting dashboard-server..."
pm2 restart dashboard-server --update-env
echo "[OK] Dashboard restarted"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Dashboard:  $DASHBOARD_URL"
echo "Gateway:    https://$GATEWAY_HOSTNAME"
echo ""
echo "These URLs are permanent. They will NOT change on restart."
echo "Cloudflared runs via PM2 and starts automatically on boot."
echo ""
echo "Notify Thorn or update Google Console with the new URLs as needed."
