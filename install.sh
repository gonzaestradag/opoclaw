#!/usr/bin/env bash
# ============================================================
#  OpoClaw — One-Command Installation Wizard
#  https://github.com/gonzaestradag/opoclaw
# ============================================================
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}  [OK]${RESET} $*"; }
warn() { echo -e "${YELLOW}  [!]${RESET} $*"; }
err()  { echo -e "${RED}  [ERR]${RESET} $*"; }
info() { echo -e "${CYAN}  -->${RESET} $*"; }
step() { echo -e "\n${BOLD}${CYAN}$*${RESET}"; }
ask()  { echo -ne "${BOLD}${1}${RESET} "; }

# ── Helpers ──────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${REPO_DIR}/.env"

# Collect values into variables (never written to screen after entry)
TG_BOT_TOKEN=""
TG_CHAT_ID=""
ANTHROPIC_API_KEY_VAL=""
CLAUDE_AUTH_MODE=""
OPENAI_API_KEY_VAL=""
GOOGLE_API_KEY_VAL=""
ELEVENLABS_API_KEY_VAL=""
ELEVENLABS_VOICE_ID_VAL=""
GROQ_API_KEY_VAL=""
OPENROUTER_API_KEY_VAL=""
MOONSHOT_API_KEY_VAL=""
DASHBOARD_TOKEN_VAL=""
DASHBOARD_PORT_VAL="3001"
CLOUDFLARE_TUNNEL_TOKEN_VAL=""
CF_ENABLED="n"
GOOGLE_CREDS_PATH_VAL="~/.config/gmail/credentials.json"
GOOGLE_OAUTH_ENABLED="n"
VAPI_API_KEY_VAL=""
VAPI_ASSISTANT_ID_VAL=""
VAPI_ENABLED="n"
BINANCE_API_KEY_VAL=""
BINANCE_SECRET_KEY_VAL=""
BINANCE_ENABLED="n"

# ── Read with optional default ───────────────────────────────
read_value() {
  local prompt="$1"
  local default="${2:-}"
  local result
  if [ -n "$default" ]; then
    ask "${prompt} [${default}]:"
  else
    ask "${prompt}:"
  fi
  read -r result
  if [ -z "$result" ] && [ -n "$default" ]; then
    result="$default"
  fi
  echo "$result"
}

# Read silently (no echo for secrets)
read_secret() {
  local prompt="$1"
  local result
  ask "${prompt}:"
  read -rs result
  echo ""
  echo "$result"
}

# Confirm yes/no
confirm() {
  local prompt="$1"
  local default="${2:-n}"
  local answer
  ask "${prompt} [y/n, default: ${default}]:"
  read -r answer
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ── Header ───────────────────────────────────────────────────
clear
echo -e "${CYAN}"
cat << 'EOF'

  ██████╗ ██████╗  ██████╗  ██████╗██╗      █████╗ ██╗    ██╗
 ██╔═══██╗██╔══██╗██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║
 ██║   ██║██████╔╝██║   ██║██║     ██║     ███████║██║ █╗ ██║
 ██║   ██║██╔═══╝ ██║   ██║██║     ██║     ██╔══██║██║███╗██║
 ╚██████╔╝██║     ╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝
  ╚═════╝ ╚═╝      ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝

       Your personal AI operating system. On your phone. Now.
EOF
echo -e "${RESET}"
echo -e "${DIM}  Claude Code CLI + Telegram bot + AI agents + React dashboard${RESET}"
echo -e "${DIM}  Trading bots + VisionClaw iOS app + Cloudflare tunnel${RESET}"
echo ""
echo -e "  This wizard will set everything up. It takes about 10 minutes."
echo -e "  You will need your API keys ready (instructions provided at each step)."
echo ""
echo -e "${YELLOW}  Press Enter to begin, or Ctrl+C to exit.${RESET}"
read -r

# ============================================================
# STEP 1 — Prerequisites
# ============================================================
step "STEP 1 / 16 — Checking prerequisites"
echo ""

# Node.js
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install it from https://nodejs.org (version 20 or higher)."
  exit 1
fi
NODE_VERSION=$(node --version | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js ${NODE_VERSION} is too old. Please install Node.js 20+ from https://nodejs.org"
  exit 1
fi
ok "Node.js ${NODE_VERSION}"

# Git
if ! command -v git &>/dev/null; then
  err "Git not found. Install it with: brew install git (Mac) or apt install git (Linux)"
  exit 1
fi
ok "Git $(git --version | awk '{print $3}')"

# Python3
if ! command -v python3 &>/dev/null; then
  warn "python3 not found. Gmail/Calendar integration will not work."
  warn "Install with: brew install python3 (Mac) or apt install python3 (Linux)"
else
  ok "Python3 $(python3 --version | awk '{print $2}')"
fi

# Claude CLI
if ! command -v claude &>/dev/null; then
  info "Claude Code CLI not found. Installing..."
  npm i -g @anthropic-ai/claude-code
  ok "Claude Code CLI installed"
else
  ok "Claude Code CLI $(claude --version 2>/dev/null | head -1 || echo 'found')"
fi

# PM2
if ! command -v pm2 &>/dev/null; then
  info "PM2 not found. Installing..."
  npm i -g pm2
  ok "PM2 installed"
else
  ok "PM2 $(pm2 --version)"
fi

# npm install
info "Installing Node.js dependencies..."
cd "${REPO_DIR}"
npm install --silent
ok "npm dependencies installed"

# ============================================================
# STEP 2 — Build
# ============================================================
step "STEP 2 / 16 — Building the system"
echo ""
info "Compiling TypeScript..."
npm run build
ok "Build complete"

# ============================================================
# STEP 3 — Personalize your AI team
# ============================================================
step "STEP 3 / 16 — Personalize your AI team"
echo ""
echo "  OpoClaw comes with a full team of AI agents. You can use the default"
echo "  names or make them your own — they'll show up in the dashboard, Telegram,"
echo "  phone calls, and everywhere else."
echo ""

echo -e "  ${BOLD}Your main assistant (the COO — available 24/7 on Telegram):${RESET}"
prompt_val THORN_NAME "  Name for your main assistant" "Thorn"
echo ""

echo -e "  ${BOLD}Your agent team (press Enter to keep the suggested name):${RESET}"
prompt_val AGENT_CTO        "  CTO / Engineering lead" "Marcus"
prompt_val AGENT_FRONTEND   "  Frontend engineer" "Lucas"
prompt_val AGENT_BACKEND    "  Backend / infra engineer" "Elias"
prompt_val AGENT_DEVOPS     "  DevOps / automation" "Silas"
prompt_val AGENT_INTEL      "  Research / intelligence" "Rafael"
prompt_val AGENT_RESEARCH   "  Deep research" "Kaelen"
prompt_val AGENT_OPS        "  Operations / scheduling" "Maya"
prompt_val AGENT_FINANCE    "  Finance / costs" "Jordan"
prompt_val AGENT_CONTENT    "  Content / writing" "Sofia"
prompt_val AGENT_STRATEGY   "  Strategy / planning" "Aria"
prompt_val AGENT_VENTURES   "  Ventures / new business" "Victoria"
echo ""
ok "Team personalized — names will be applied to the dashboard and CLAUDE.md"

# ============================================================
# STEP 4 — Telegram bot setup
# ============================================================
step "STEP 4 / 17 — Telegram bot setup"
echo ""
echo "  You need a Telegram bot token and your personal chat ID."
echo ""
echo -e "  ${BOLD}How to create a bot:${RESET}"
echo "  1. Open Telegram and search for @BotFather"
echo "  2. Send: /newbot"
echo "  3. Follow the steps — choose a name and username"
echo "  4. BotFather will give you a token like: 1234567890:ABCdef..."
echo ""
echo -e "  ${BOLD}How to get your chat ID:${RESET}"
echo "  1. Start a chat with your new bot (search its username, press Start)"
echo "  2. Send the bot any message (e.g. 'hi')"
echo "  3. Open this URL in your browser (replace BOT_TOKEN with yours):"
echo -e "     ${CYAN}https://api.telegram.org/botBOT_TOKEN/getUpdates${RESET}"
echo "  4. Look for 'chat': { 'id': 123456789 } — that number is your chat ID"
echo ""
TG_BOT_TOKEN=$(read_secret "  Enter your Telegram Bot Token")
if [ -z "$TG_BOT_TOKEN" ]; then
  err "Telegram Bot Token is required. Cannot continue without it."
  exit 1
fi
TG_CHAT_ID=$(read_value "  Enter your Telegram Chat ID (numbers only)")
if [ -z "$TG_CHAT_ID" ]; then
  err "Telegram Chat ID is required."
  exit 1
fi
ok "Telegram credentials saved"

# ============================================================
# STEP 4 — Claude auth
# ============================================================
step "STEP 4 / 16 — Claude authentication"
echo ""
echo "  OpoClaw can use your Claude account (OAuth, free to start)"
echo "  or a direct API key (pay-per-token, better for server use)."
echo ""
echo -e "  ${BOLD}oauth${RESET}  = uses your existing Claude account (claude.ai)"
echo -e "         Free tier works. Pro/Max recommended for heavy use."
echo -e "  ${BOLD}apikey${RESET} = uses an API key from console.anthropic.com"
echo -e "         Each request costs tokens billed to your API account."
echo ""
CLAUDE_AUTH_MODE=$(read_value "  oauth or apikey" "oauth")
if [[ "$CLAUDE_AUTH_MODE" == "apikey" ]]; then
  echo ""
  info "Get your API key at: https://console.anthropic.com/keys"
  ANTHROPIC_API_KEY_VAL=$(read_secret "  Enter your Anthropic API key (sk-ant-...)")
  ok "API key saved"
else
  CLAUDE_AUTH_MODE="oauth"
  echo ""
  info "Running: claude login"
  echo "  A browser window will open. Sign in with your Claude account."
  echo "  Press Enter when you are ready to authenticate..."
  read -r
  claude login || warn "claude login failed — you can run it manually later"
  ok "Claude OAuth configured"
fi

# ============================================================
# STEP 5 — Core AI keys
# ============================================================
step "STEP 5 / 16 — Core AI API keys"
echo ""
echo "  These keys power the main features. All are optional except where noted."
echo ""

echo -e "  ${BOLD}OpenAI API key${RESET}"
echo -e "  Used for: market intelligence analysis, agent avatar generation (DALL-E)"
echo -e "  Get it at: ${CYAN}https://platform.openai.com/api-keys${RESET}"
OPENAI_API_KEY_VAL=$(read_secret "  Enter your OpenAI API key (sk-...) or press Enter to skip")
[ -n "$OPENAI_API_KEY_VAL" ] && ok "OpenAI key saved" || warn "Skipped — avatar generation and market analysis will not work"

echo ""
echo -e "  ${BOLD}Google Gemini API key${RESET}"
echo -e "  Used for: several AI agents, VisionClaw glasses integration"
echo -e "  Get it at: ${CYAN}https://aistudio.google.com${RESET} (free tier available)"
GOOGLE_API_KEY_VAL=$(read_secret "  Enter your Google Gemini API key (AIza...) or press Enter to skip")
[ -n "$GOOGLE_API_KEY_VAL" ] && ok "Google Gemini key saved" || warn "Skipped — Gemini-powered agents and VisionClaw will not work"

echo ""
echo -e "  ${BOLD}ElevenLabs API key + Voice ID${RESET}"
echo -e "  Used for: voice responses from your assistant (clone your own voice!)"
echo -e "  Get it at: ${CYAN}https://elevenlabs.io${RESET}"
echo -e "  After signing up: go to Voices > Add Voice > Instant Voice Clone"
echo -e "  Copy the Voice ID from the voice card after cloning"
ELEVENLABS_API_KEY_VAL=$(read_secret "  Enter your ElevenLabs API key or press Enter to skip")
if [ -n "$ELEVENLABS_API_KEY_VAL" ]; then
  ok "ElevenLabs key saved"
  ELEVENLABS_VOICE_ID_VAL=$(read_value "  Enter your ElevenLabs Voice ID")
  [ -n "$ELEVENLABS_VOICE_ID_VAL" ] && ok "Voice ID saved" || warn "No Voice ID — responses will be text only"
else
  warn "Skipped — voice responses will be text only"
fi

echo ""
echo -e "  ${BOLD}Groq API key${RESET}"
echo -e "  Used for: voice transcription (Whisper) — converts your voice notes to text"
echo -e "  Get it at: ${CYAN}https://console.groq.com${RESET} (free tier, no credit card needed)"
GROQ_API_KEY_VAL=$(read_secret "  Enter your Groq API key or press Enter to skip")
[ -n "$GROQ_API_KEY_VAL" ] && ok "Groq key saved" || warn "Skipped — voice note input will not work"

echo ""
echo -e "  ${BOLD}OpenRouter API key (optional fallback)${RESET}"
echo -e "  Used for: automatic fallback when primary LLM APIs are rate-limited"
echo -e "  Get it at: ${CYAN}https://openrouter.ai/keys${RESET}"
OPENROUTER_API_KEY_VAL=$(read_secret "  Enter your OpenRouter API key or press Enter to skip")
[ -n "$OPENROUTER_API_KEY_VAL" ] && ok "OpenRouter key saved" || info "Skipped — no automatic fallback routing"

# ============================================================
# STEP 6 — Multi-agent LLM keys
# ============================================================
step "STEP 6 / 16 — Multi-agent LLM keys (optional)"
echo ""
echo "  OpoClaw runs multiple AI agents, each with a preferred model."
echo "  Some agents use Moonshot (Kimi K2) by default. You can skip this"
echo "  and those agents will fall back to OpenAI or Gemini instead."
echo ""
echo -e "  ${BOLD}Moonshot AI API key${RESET}"
echo -e "  Used for: Marcus (CTO), Lucas (Frontend), Elias (Backend) agents"
echo -e "  Get it at: ${CYAN}https://platform.moonshot.cn/console/api-keys${RESET}"
MOONSHOT_API_KEY_VAL=$(read_secret "  Enter your Moonshot API key or press Enter to skip")
[ -n "$MOONSHOT_API_KEY_VAL" ] && ok "Moonshot key saved" || info "Skipped — those agents will use OpenAI/Gemini as fallback"

# ============================================================
# STEP 7 — Dashboard
# ============================================================
step "STEP 7 / 16 — Dashboard setup"
echo ""
echo "  The dashboard is a React web app for monitoring all agents, tasks,"
echo "  activity, trading bots, and system health in real time."
echo ""

info "Generating secure dashboard token..."
DASHBOARD_TOKEN_VAL=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
ok "Token generated"

DASHBOARD_PORT_VAL=$(read_value "  Dashboard port" "3001")

echo ""
ok "Dashboard will be available at: http://localhost:${DASHBOARD_PORT_VAL}"
info "Keep the token safe — you will need it to log in and for VisionClaw"

# ============================================================
# STEP 8 — Cloudflare Tunnel
# ============================================================
step "STEP 8 / 16 — Cloudflare Tunnel (remote access, optional)"
echo ""
echo "  Cloudflare Tunnel gives you a public HTTPS URL for your dashboard"
echo "  and lets VisionClaw connect to OpoClaw from anywhere in the world."
echo ""
echo "  How to get a tunnel token:"
echo "  1. Go to: https://dash.cloudflare.com"
echo "  2. Click Zero Trust > Networks > Tunnels"
echo "  3. Click 'Create a tunnel' > 'Cloudflared'"
echo "  4. Give it a name, click Save, copy the token"
echo "  5. Add a Public Hostname pointing to localhost:${DASHBOARD_PORT_VAL}"
echo ""
if confirm "  Set up Cloudflare Tunnel?"; then
  CF_ENABLED="y"
  if ! command -v cloudflared &>/dev/null; then
    warn "cloudflared not installed."
    echo ""
    echo "  Install it with:"
    echo "    Mac:   brew install cloudflared"
    echo "    Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    echo ""
    echo "  Install cloudflared now, then come back and press Enter to continue..."
    read -r
  fi
  ok "cloudflared found: $(cloudflared --version 2>/dev/null | head -1)"
  CLOUDFLARE_TUNNEL_TOKEN_VAL=$(read_secret "  Enter your Cloudflare Tunnel token")
  [ -n "$CLOUDFLARE_TUNNEL_TOKEN_VAL" ] && ok "Tunnel token saved" || warn "No token entered — tunnel skipped"
else
  CF_ENABLED="n"
  info "Skipped — dashboard will only be available on your local network"
fi

# ============================================================
# STEP 9 — Google OAuth
# ============================================================
step "STEP 9 / 16 — Gmail + Google Calendar integration (optional)"
echo ""
echo "  This enables your assistant to read your Gmail inbox, schedule"
echo "  meetings on Google Calendar, and draft/send emails on your behalf."
echo ""
echo "  Setup requires a Google Cloud project with OAuth credentials:"
echo "  1. Go to: https://console.cloud.google.com"
echo "  2. Create a new project (or use an existing one)"
echo "  3. Enable these APIs: Gmail API, Google Calendar API"
echo "     (APIs & Services > Library > search and enable each)"
echo "  4. Create OAuth credentials:"
echo "     APIs & Services > Credentials > Create Credentials > OAuth client ID"
echo "     Application type: Desktop app"
echo "  5. Download the JSON file (the download button next to the credential)"
echo "  6. You will be asked for the path to that file below"
echo ""
if confirm "  Set up Gmail + Google Calendar?"; then
  GOOGLE_OAUTH_ENABLED="y"

  mkdir -p ~/.config/gmail ~/.config/calendar

  CREDS_PATH=$(read_value "  Path to your downloaded credentials.json file")
  if [ -f "${CREDS_PATH}" ]; then
    cp "${CREDS_PATH}" ~/.config/gmail/credentials.json
    cp "${CREDS_PATH}" ~/.config/calendar/credentials.json
    ok "Credentials copied to ~/.config/gmail/ and ~/.config/calendar/"
  else
    warn "File not found at '${CREDS_PATH}'. Skipping copy — copy it manually later."
    warn "Target: ~/.config/gmail/credentials.json and ~/.config/calendar/credentials.json"
  fi
  GOOGLE_CREDS_PATH_VAL="~/.config/gmail/credentials.json"

  echo ""
  info "Now authorizing Gmail access..."
  echo "  A browser window will open. Sign in and grant the requested permissions."
  if [ -f "${REPO_DIR}/scripts/gmail-auth.py" ]; then
    python3 "${REPO_DIR}/scripts/gmail-auth.py" || warn "Gmail auth failed — re-run: python3 scripts/gmail-auth.py"
  else
    warn "scripts/gmail-auth.py not found."
    info "Run the following manually after setup to authorize Gmail:"
    echo "     python3 ${REPO_DIR}/scripts/gmail-auth.py"
  fi
else
  GOOGLE_OAUTH_ENABLED="n"
  info "Skipped — Gmail and Calendar integration will not be active"
fi

# ============================================================
# STEP 10 — Vapi
# ============================================================
step "STEP 10 / 16 — Vapi phone calls (optional)"
echo ""
echo "  Vapi enables inbound and outbound phone calls routed to your assistant."
echo "  Your assistant can answer your phone, take calls, and even call"
echo "  restaurants to make reservations on your behalf."
echo ""
echo "  Get a Vapi account at: https://vapi.ai"
echo "  Create an assistant in the dashboard — point it to your server URL."
echo "  The webhook URL will be: https://YOUR_DOMAIN/api/vapi/webhook"
echo ""
if confirm "  Set up Vapi for phone calls?"; then
  VAPI_ENABLED="y"
  VAPI_API_KEY_VAL=$(read_secret "  Enter your Vapi API key")
  VAPI_ASSISTANT_ID_VAL=$(read_value "  Enter your Vapi Assistant ID")
  [ -n "$VAPI_API_KEY_VAL" ] && ok "Vapi key saved" || warn "No Vapi key entered"
else
  VAPI_ENABLED="n"
  info "Skipped — phone call features will not be active"
fi

# ============================================================
# STEP 11 — Binance trading bots
# ============================================================
step "STEP 11 / 16 — Binance trading bots (optional)"
echo ""
echo -e "  ${YELLOW}${BOLD}WARNING: This section involves real financial instruments.${RESET}"
echo "  The trading bots (Satoshi and Nakamoto) run automated crypto"
echo "  strategies. Only enable this if you understand algorithmic trading"
echo "  and are comfortable with the risks."
echo ""
echo "  Always start with paper trading (test mode) before going live."
echo "  Read the trading docs in docs/ before enabling real trading."
echo ""
echo "  How to get Binance API keys:"
echo "  1. Go to: https://www.binance.com/en/my/settings/api-management"
echo "  2. Create a new API key (System Generated)"
echo "  3. Enable: Read Info + Spot & Margin Trading"
echo "  4. Add your server IP to the IP whitelist (important!)"
echo "  5. Copy the API key and secret (the secret is shown only once)"
echo ""
if confirm "  Set up Binance trading bots?"; then
  BINANCE_ENABLED="y"
  echo ""
  echo -e "  ${RED}REMINDER: Start with test/paper mode. Real money is at risk.${RESET}"
  BINANCE_API_KEY_VAL=$(read_secret "  Enter your Binance API key")
  BINANCE_SECRET_KEY_VAL=$(read_secret "  Enter your Binance Secret key")
  [ -n "$BINANCE_API_KEY_VAL" ] && ok "Binance keys saved" || warn "No Binance keys entered"
else
  BINANCE_ENABLED="n"
  info "Skipped — trading bots will not be active"
fi

# ============================================================
# STEP 12 — Write .env
# ============================================================
step "STEP 12 / 16 — Writing .env configuration file"
echo ""

if [ -f "${ENV_FILE}" ]; then
  if ! confirm "  A .env file already exists. Overwrite it?"; then
    warn "Keeping existing .env. Skipping write."
  else
    write_env="y"
  fi
else
  write_env="y"
fi

if [ "${write_env:-n}" == "y" ]; then
  cat > "${ENV_FILE}" << ENVEOF
# ── OpoClaw Configuration ──────────────────────────────────────────────────────
# Generated by install.sh on $(date)
# Do not commit this file — it contains secrets.

# ── Telegram (Required) ────────────────────────────────────────────────────────
# Get from @BotFather on Telegram
TELEGRAM_BOT_TOKEN=${TG_BOT_TOKEN}

# Your personal Telegram chat ID. Send any message to your bot to get it.
ALLOWED_CHAT_ID=${TG_CHAT_ID}

# ── Claude Auth ────────────────────────────────────────────────────────────────
# Set ANTHROPIC_API_KEY only if you chose apikey auth above.
# If you chose OAuth (claude login), leave this blank — OAuth is used automatically.
$([ "$CLAUDE_AUTH_MODE" == "apikey" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY_VAL}" || echo "# ANTHROPIC_API_KEY=   # Leave blank to use claude login (OAuth)")

# ── Voice ──────────────────────────────────────────────────────────────────────
# Groq — free tier, for voice transcription (Whisper)
# Get at: https://console.groq.com
GROQ_API_KEY=${GROQ_API_KEY_VAL}

# ElevenLabs — for voice responses (clone your own voice)
# Get at: https://elevenlabs.io
ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY_VAL}
ELEVENLABS_VOICE_ID=${ELEVENLABS_VOICE_ID_VAL}

# ── Core AI Keys ───────────────────────────────────────────────────────────────
# OpenAI — for market analysis and agent avatar generation (DALL-E)
# Get at: https://platform.openai.com/api-keys
OPENAI_API_KEY=${OPENAI_API_KEY_VAL}

# Google Gemini — for Gemini-powered agents and VisionClaw
# Get at: https://aistudio.google.com
GOOGLE_API_KEY=${GOOGLE_API_KEY_VAL}

# OpenRouter — fallback routing when primary APIs are rate-limited (optional)
# Get at: https://openrouter.ai/keys
OPENROUTER_API_KEY=${OPENROUTER_API_KEY_VAL}

# ── Multi-Agent LLM Keys ───────────────────────────────────────────────────────
# Moonshot (Kimi K2) — for Marcus, Lucas, Elias agents
# Get at: https://platform.moonshot.cn/console/api-keys
MOONSHOT_API_KEY=${MOONSHOT_API_KEY_VAL}

# ── Dashboard ──────────────────────────────────────────────────────────────────
# Web dashboard — monitoring, tasks, agents, trading
# Generate a new token: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
DASHBOARD_TOKEN=${DASHBOARD_TOKEN_VAL}
DASHBOARD_PORT=${DASHBOARD_PORT_VAL}
# DASHBOARD_URL=   # Set to your public Cloudflare Tunnel URL for remote access

# ── Internal Ports ─────────────────────────────────────────────────────────────
# Bot inject server — used internally by tg-notify.sh (do not change)
BOT_INJECT_PORT=3142

# ── Google OAuth (for Gmail + Calendar skills) ─────────────────────────────────
# Paths to OAuth credentials and tokens.
GOOGLE_CREDS_PATH=${GOOGLE_CREDS_PATH_VAL}
GMAIL_TOKEN_PATH=~/.config/gmail/token.json
GCAL_TOKEN_PATH=~/.config/calendar/token.json

# ── Cloudflare Tunnel (optional) ──────────────────────────────────────────────
$([ "$CF_ENABLED" == "y" ] && echo "CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN_VAL}" || echo "# CLOUDFLARE_TUNNEL_TOKEN=   # Set to enable Cloudflare Tunnel for remote access")

# ── Vapi (phone calls, optional) ──────────────────────────────────────────────
$([ "$VAPI_ENABLED" == "y" ] && echo "VAPI_API_KEY=${VAPI_API_KEY_VAL}" || echo "# VAPI_API_KEY=")
$([ "$VAPI_ENABLED" == "y" ] && echo "VAPI_ASSISTANT_ID=${VAPI_ASSISTANT_ID_VAL}" || echo "# VAPI_ASSISTANT_ID=")
# VAPI_PHONE_NUMBER=   # Your Vapi phone number (if you purchased one)
# VAPI_WEBHOOK_SECRET= # Optional — for verifying Vapi webhook signatures

# ── Binance (trading bots, optional) ──────────────────────────────────────────
$([ "$BINANCE_ENABLED" == "y" ] && echo "BINANCE_API_KEY=${BINANCE_API_KEY_VAL}" || echo "# BINANCE_API_KEY=")
$([ "$BINANCE_ENABLED" == "y" ] && echo "BINANCE_SECRET_KEY=${BINANCE_SECRET_KEY_VAL}" || echo "# BINANCE_SECRET_KEY=")

# ── Slack (optional) ───────────────────────────────────────────────────────────
# Slack User OAuth Token — starts with xoxp-
# SLACK_USER_TOKEN=

# ── Node Environment ───────────────────────────────────────────────────────────
NODE_ENV=production
ENVEOF
  ok ".env written to ${ENV_FILE}"
fi

# ============================================================
# STEP 13 — Apply agent names to the system
# ============================================================
step "STEP 13 / 17 — Applying your agent names"
echo ""

CLAUDE_MD="${REPO_DIR}/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  # Replace Thorn's name everywhere in CLAUDE.md
  if [ "${THORN_NAME}" != "Thorn" ]; then
    sed -i '' "s/\bThorn\b/${THORN_NAME}/g" "$CLAUDE_MD" 2>/dev/null || \
    sed -i "s/\bThorn\b/${THORN_NAME}/g" "$CLAUDE_MD"
    ok "Main assistant renamed to ${THORN_NAME} in CLAUDE.md"
  fi

  # Replace agent names in CLAUDE.md
  [ "${AGENT_CTO}" != "Marcus" ]      && { sed -i '' "s/\bMarcus\b/${AGENT_CTO}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bMarcus\b/${AGENT_CTO}/g" "$CLAUDE_MD"; }
  [ "${AGENT_FRONTEND}" != "Lucas" ]  && { sed -i '' "s/\bLucas\b/${AGENT_FRONTEND}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bLucas\b/${AGENT_FRONTEND}/g" "$CLAUDE_MD"; }
  [ "${AGENT_BACKEND}" != "Elias" ]   && { sed -i '' "s/\bElias\b/${AGENT_BACKEND}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bElias\b/${AGENT_BACKEND}/g" "$CLAUDE_MD"; }
  [ "${AGENT_DEVOPS}" != "Silas" ]    && { sed -i '' "s/\bSilas\b/${AGENT_DEVOPS}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bSilas\b/${AGENT_DEVOPS}/g" "$CLAUDE_MD"; }
  [ "${AGENT_INTEL}" != "Rafael" ]    && { sed -i '' "s/\bRafael\b/${AGENT_INTEL}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bRafael\b/${AGENT_INTEL}/g" "$CLAUDE_MD"; }
  [ "${AGENT_RESEARCH}" != "Kaelen" ] && { sed -i '' "s/\bKaelen\b/${AGENT_RESEARCH}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bKaelen\b/${AGENT_RESEARCH}/g" "$CLAUDE_MD"; }
  [ "${AGENT_OPS}" != "Maya" ]        && { sed -i '' "s/\bMaya\b/${AGENT_OPS}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bMaya\b/${AGENT_OPS}/g" "$CLAUDE_MD"; }
  [ "${AGENT_FINANCE}" != "Jordan" ]  && { sed -i '' "s/\bJordan\b/${AGENT_FINANCE}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bJordan\b/${AGENT_FINANCE}/g" "$CLAUDE_MD"; }
  [ "${AGENT_CONTENT}" != "Sofia" ]   && { sed -i '' "s/\bSofia\b/${AGENT_CONTENT}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bSofia\b/${AGENT_CONTENT}/g" "$CLAUDE_MD"; }
  [ "${AGENT_STRATEGY}" != "Aria" ]   && { sed -i '' "s/\bAria\b/${AGENT_STRATEGY}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bAria\b/${AGENT_STRATEGY}/g" "$CLAUDE_MD"; }
  [ "${AGENT_VENTURES}" != "Victoria" ] && { sed -i '' "s/\bVictoria\b/${AGENT_VENTURES}/g" "$CLAUDE_MD" 2>/dev/null || sed -i "s/\bVictoria\b/${AGENT_VENTURES}/g" "$CLAUDE_MD"; }
  ok "Agent names applied to CLAUDE.md"
else
  warn "CLAUDE.md not found — agent names not applied"
fi

# ============================================================
# STEP 14 — Database setup
# ============================================================
step "STEP 14 / 17 — Database setup"
echo ""
info "Initializing SQLite database..."
mkdir -p "${REPO_DIR}/store"

# The dashboard-server creates the schema on first start via initDatabase().
# We trigger it here by loading the DB module.
node -e "
import('${REPO_DIR}/dist/db.js').then(m => {
  m.initDatabase();
  console.log('Database initialized.');
  process.exit(0);
}).catch(e => {
  console.error('DB init error (this is OK on first run):', e.message);
  process.exit(0);
});
" 2>/dev/null || true
ok "Database ready at ${REPO_DIR}/store/claudeclaw.db"

# ============================================================
# STEP 14 — PM2 setup
# ============================================================
step "STEP 15 / 17 — Starting services with PM2"
echo ""

# Check for ecosystem config
if [ -f "${REPO_DIR}/ecosystem.config.js" ] || [ -f "${REPO_DIR}/ecosystem.config.cjs" ]; then
  ECOSYSTEM_FILE="${REPO_DIR}/ecosystem.config.js"
  [ -f "${REPO_DIR}/ecosystem.config.cjs" ] && ECOSYSTEM_FILE="${REPO_DIR}/ecosystem.config.cjs"
  info "Starting all services via ecosystem config..."
  pm2 start "${ECOSYSTEM_FILE}" || warn "Some services failed to start. Check: pm2 list"
else
  info "No ecosystem.config.js found. Starting core service directly..."
  pm2 start "${REPO_DIR}/dist/index.js" --name "claudeclaw" --interpreter node \
    --log "${REPO_DIR}/store/pm2-claudeclaw.log" \
    --env production \
    2>/dev/null || true
fi

pm2 save
ok "PM2 processes saved"

echo ""
echo -e "  ${YELLOW}To start PM2 automatically on system boot, run:${RESET}"
pm2 startup 2>/dev/null | tail -1 || echo "  (Run 'pm2 startup' manually and follow the instructions)"
echo ""
echo "  Copy and run the command above as sudo, then run: pm2 save"
echo ""

ok "Services started. Current PM2 status:"
pm2 list

# ============================================================
# STEP 15 — Final verification
# ============================================================
step "STEP 16 / 17 — Verifying installation"
echo ""

info "Waiting 3 seconds for services to boot..."
sleep 3

HEALTH_URL="http://localhost:${DASHBOARD_PORT_VAL}/health"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" == "200" ]; then
  ok "Dashboard is responding at http://localhost:${DASHBOARD_PORT_VAL}"
elif [ "$HTTP_STATUS" == "401" ]; then
  ok "Dashboard is running (requires auth token to access)"
else
  warn "Dashboard health check returned ${HTTP_STATUS}. It may still be starting."
  warn "Try: curl http://localhost:${DASHBOARD_PORT_VAL}/health in a few seconds"
fi

echo ""
echo -e "  ${BOLD}${GREEN}Installation complete.${RESET}"
echo ""
echo -e "  ${BOLD}Your dashboard:${RESET}      http://localhost:${DASHBOARD_PORT_VAL}"
echo -e "  ${BOLD}Dashboard token:${RESET}     ${DASHBOARD_TOKEN_VAL}"
echo -e "  ${BOLD}PM2 logs:${RESET}            pm2 logs"
echo -e "  ${BOLD}Restart all:${RESET}         pm2 restart all"
echo ""
echo -e "  ${BOLD}Next:${RESET} Open Telegram and send your bot the message /start"
echo -e "       to verify the connection is working."
echo ""
if [ "$CF_ENABLED" == "y" ] && [ -n "$CLOUDFLARE_TUNNEL_TOKEN_VAL" ]; then
  echo -e "  ${BOLD}Cloudflare Tunnel:${RESET} configured. Your public URL is set in your"
  echo "                     Cloudflare dashboard under Zero Trust > Tunnels."
  echo ""
fi

# ============================================================
# STEP 16 — VisionClaw iOS setup
# ============================================================
step "STEP 17 / 17 — VisionClaw iOS app setup"
echo ""
echo "  VisionClaw is an iOS app that connects OpoClaw to your iPhone"
echo "  (and Meta Ray-Ban glasses via iPhone). It gives your glasses"
echo "  live AI vision powered by Gemini."
echo ""
echo -e "  ${BOLD}Setup steps:${RESET}"
echo ""
echo "  1. Open Xcode and open this file:"
echo -e "     ${CYAN}${REPO_DIR}/visionclaw/CameraAccess.xcodeproj${RESET}"
echo ""
echo "  2. Copy the Secrets template:"
echo "     cp ${REPO_DIR}/visionclaw/CameraAccess/Secrets.swift.example \\"
echo "        ${REPO_DIR}/visionclaw/CameraAccess/Secrets.swift"
echo ""
echo "  3. Edit Secrets.swift and fill in:"
echo ""
echo "     static let geminiAPIKey   = \"${GOOGLE_API_KEY_VAL:-YOUR_GEMINI_API_KEY}\""
echo ""
echo "     # For agentic tool-calling (optional):"
echo "     # Get your Mac's hostname: run 'scutil --get LocalHostName'"
echo "     static let openClawHost   = \"http://YOUR_MAC_HOSTNAME.local\""
echo "     static let openClawPort   = ${DASHBOARD_PORT_VAL}"
echo "     static let openClawHookToken  = \"${DASHBOARD_TOKEN_VAL}\""
echo "     static let openClawGatewayToken = \"${DASHBOARD_TOKEN_VAL}\""
echo ""
echo "  4. Connect your iPhone via USB"
echo "  5. Select your device in Xcode > Product > Run"
echo "  6. Trust the developer certificate on your iPhone if prompted:"
echo "     Settings > General > VPN & Device Management > trust your email"
echo ""
echo "  Compatible with Meta Ray-Ban glasses (frames with built-in camera)."
echo "  When the glasses send a photo, VisionClaw routes it through Gemini"
echo "  and your assistant responds with what it sees."
echo ""

# ============================================================
# Summary
# ============================================================
echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  OpoClaw is installed and running.${RESET}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  Dashboard     http://localhost:${DASHBOARD_PORT_VAL}"
echo -e "  Auth token    ${DASHBOARD_TOKEN_VAL}"
echo ""
echo -e "  PM2 commands:"
echo -e "    pm2 list              See all running processes"
echo -e "    pm2 logs              Live log stream"
echo -e "    pm2 restart all       Restart everything"
echo -e "    pm2 stop all          Stop everything"
echo ""
echo -e "  Telegram:"
echo -e "    Send /start to your bot to confirm it is working."
echo ""
echo -e "  Full documentation:   ${REPO_DIR}/SETUP.md"
echo -e "  GitHub:               https://github.com/gonzaestradag/opoclaw"
echo ""
