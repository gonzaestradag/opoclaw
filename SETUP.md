# OpoClaw — Setup Reference

Quick install: run `./install.sh` and follow the wizard.
This file is the manual reference for when you need to look something up or set up a piece individually.

---

## Table of Contents

1. [What each env var does](#env-vars)
2. [Getting each API key](#api-keys)
3. [Google OAuth step-by-step](#google-oauth)
4. [VisionClaw iOS setup](#visionclaw)
5. [Cloudflare Tunnel setup](#cloudflare)
6. [PM2 commands reference](#pm2)
7. [Troubleshooting](#troubleshooting)

---

## Env Vars

Every variable used by OpoClaw, what it does, and where to get it.

### Required

| Variable | What it does | Where to get it |
|----------|-------------|----------------|
| `TELEGRAM_BOT_TOKEN` | Authenticates your Telegram bot | @BotFather on Telegram |
| `ALLOWED_CHAT_ID` | Your personal Telegram user ID — only this ID can send commands | Send a message to your bot, then visit `https://api.telegram.org/botTOKEN/getUpdates` |

### Claude Auth (choose one)

| Variable | What it does | Notes |
|----------|-------------|-------|
| `ANTHROPIC_API_KEY` | Pay-per-token API key | Leave blank if using `claude login` (OAuth) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Override which Claude account is used | Advanced, optional |

If you used `claude login`, leave both blank. The CLI finds credentials in `~/.claude/` automatically.

### Voice

| Variable | What it does | Where to get it |
|----------|-------------|----------------|
| `GROQ_API_KEY` | Voice transcription — converts your voice notes to text | https://console.groq.com (free) |
| `ELEVENLABS_API_KEY` | Text-to-speech — your assistant replies with your cloned voice | https://elevenlabs.io |
| `ELEVENLABS_VOICE_ID` | Which voice to use in ElevenLabs | Voices tab in ElevenLabs dashboard |

### Core AI

| Variable | What it does | Where to get it |
|----------|-------------|----------------|
| `OPENAI_API_KEY` | Market intelligence analysis, DALL-E avatar generation | https://platform.openai.com/api-keys |
| `GOOGLE_API_KEY` | Gemini-powered agents (Maya, Rafael, Jordan, Silas, Kaelen), VisionClaw | https://aistudio.google.com |
| `OPENROUTER_API_KEY` | Fallback LLM routing when primary APIs hit rate limits | https://openrouter.ai/keys |
| `MOONSHOT_API_KEY` | Kimi K2 model for Marcus, Lucas, Elias agents | https://platform.moonshot.cn/console/api-keys |

### Dashboard

| Variable | What it does | Default |
|----------|-------------|---------|
| `DASHBOARD_TOKEN` | Bearer token for dashboard API and VisionClaw auth | Generate: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `DASHBOARD_PORT` | Port the dashboard web server listens on | `3001` |
| `DASHBOARD_URL` | Public URL (set to your Cloudflare Tunnel URL) | Optional |
| `BOT_INJECT_PORT` | Internal port for tg-notify.sh message injection | `3142` |

### Google OAuth

| Variable | What it does |
|----------|-------------|
| `GOOGLE_CREDS_PATH` | Path to your OAuth `credentials.json` from Google Cloud Console |
| `GMAIL_TOKEN_PATH` | Where the Gmail access token is stored after first authorization |
| `GCAL_TOKEN_PATH` | Where the Google Calendar access token is stored |

### Optional Integrations

| Variable | What it does | Where to get it |
|----------|-------------|----------------|
| `CLOUDFLARE_TUNNEL_TOKEN` | Token for Cloudflare Tunnel (public HTTPS URL) | dash.cloudflare.com > Zero Trust > Tunnels |
| `VAPI_API_KEY` | Vapi API key for phone call features | https://vapi.ai |
| `VAPI_ASSISTANT_ID` | Your Vapi assistant ID | Vapi dashboard |
| `VAPI_PHONE_NUMBER` | Your Vapi phone number | Vapi dashboard |
| `VAPI_WEBHOOK_SECRET` | Webhook signature verification | Vapi dashboard |
| `BINANCE_API_KEY` | Binance API key for trading bots | binance.com > API Management |
| `BINANCE_SECRET_KEY` | Binance API secret | Created alongside API key |
| `SLACK_USER_TOKEN` | Slack user token (starts with `xoxp-`) | Slack app settings |
| `WHATSAPP_ENABLED` | Enable WhatsApp bridge | Set to `true` if running wa-daemon.ts |
| `BUDGET_USD` | Monthly AI spend limit tracked by Jordan (Finance) | Set to any number, default `50.0` |
| `NODE_ENV` | Runtime environment | `production` |

---

## API Keys

### Telegram Bot Token

1. Open Telegram, search for **@BotFather**
2. Send: `/newbot`
3. Choose a name (e.g. "My Assistant") and a username (e.g. `myassistant_bot`)
4. BotFather replies with a token like `1234567890:ABCdef...`
5. Copy that token into `TELEGRAM_BOT_TOKEN`

**Getting your chat ID:**
1. Start a conversation with your new bot (search its username in Telegram, press Start)
2. Send it any message
3. Open in your browser: `https://api.telegram.org/botYOUR_TOKEN/getUpdates`
4. Find `"chat":{"id":123456789}` — that number is your `ALLOWED_CHAT_ID`

### Claude Auth

**Option A — OAuth (recommended for personal use):**
```bash
claude login
```
A browser window opens. Sign in with your Claude account (claude.ai). Free tier works. Pro/Max recommended for heavy use. No API key needed — leave `ANTHROPIC_API_KEY` blank.

**Option B — API key:**
1. Go to https://console.anthropic.com/keys
2. Create a new key
3. Set `ANTHROPIC_API_KEY` in `.env`
4. Note: API billing is separate from your claude.ai subscription

### Groq (voice transcription)

1. Go to https://console.groq.com
2. Sign up (free, no credit card required)
3. API Keys > Create API Key
4. Copy into `GROQ_API_KEY`

### ElevenLabs (voice responses)

1. Go to https://elevenlabs.io and sign up
2. To clone your voice: My Voices > Add a new voice > Instant Voice Clone
3. Record or upload 1 minute of clean audio
4. After cloning: click the voice > copy the Voice ID from the URL or voice card
5. API Keys section: copy your API key into `ELEVENLABS_API_KEY`
6. Copy the Voice ID into `ELEVENLABS_VOICE_ID`

### OpenAI

1. Go to https://platform.openai.com/api-keys
2. Create a new secret key
3. Add billing at https://platform.openai.com/settings/billing
4. Copy key into `OPENAI_API_KEY`

### Google Gemini

1. Go to https://aistudio.google.com
2. Sign in with your Google account
3. Click "Get API key" or go to https://aistudio.google.com/apikey
4. Create a new key
5. Copy into `GOOGLE_API_KEY`

Free tier is generous. No billing setup required to start.

### OpenRouter

1. Go to https://openrouter.ai
2. Sign up and add credits
3. Keys section: create a new key
4. Copy into `OPENROUTER_API_KEY`

### Moonshot (Kimi K2)

1. Go to https://platform.moonshot.cn/console/api-keys
2. Sign up for an account
3. Create an API key
4. Copy into `MOONSHOT_API_KEY`

---

## Google OAuth

Full step-by-step for enabling Gmail and Google Calendar integration.

### 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com
2. Click the project selector at the top > New Project
3. Give it a name (e.g. "OpoClaw") and click Create
4. Make sure the new project is selected in the top bar

### 2. Enable the APIs

1. Go to APIs & Services > Library
2. Search for **Gmail API** > click it > Enable
3. Search for **Google Calendar API** > click it > Enable

### 3. Create OAuth credentials

1. Go to APIs & Services > OAuth consent screen
2. Choose **External** (unless you have a Google Workspace account)
3. Fill in App name (e.g. "OpoClaw") and your email for support/developer fields
4. Under Scopes: click Add or Remove Scopes, add:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
5. Under Test users: add the Gmail address you will be authorizing with
6. Save and continue through all screens

7. Go to APIs & Services > Credentials
8. Click Create Credentials > OAuth client ID
9. Application type: **Desktop app**
10. Name it anything (e.g. "OpoClaw Desktop")
11. Click Create
12. Click the download icon (JSON) next to the new credential
13. Save the file somewhere you will remember

### 4. Authorize the application

```bash
# Copy credentials to the expected paths
mkdir -p ~/.config/gmail ~/.config/calendar
cp /path/to/downloaded-credentials.json ~/.config/gmail/credentials.json
cp /path/to/downloaded-credentials.json ~/.config/calendar/credentials.json

# Authorize Gmail (browser will open)
python3 scripts/gmail-auth.py

# Authorize Calendar (browser will open)
python3 scripts/gcal-auth.py
```

After authorization, token files are saved to `~/.config/gmail/token.json` and `~/.config/calendar/token.json`. These tokens refresh automatically.

### Troubleshooting Google OAuth

**"Access blocked: This app's request is invalid"**
You need to add yourself as a test user in the OAuth consent screen (step 3.5 above).

**"Token has been expired or revoked"**
Delete the token files and re-run the auth scripts:
```bash
rm ~/.config/gmail/token.json ~/.config/calendar/token.json
python3 scripts/gmail-auth.py
python3 scripts/gcal-auth.py
```

---

## VisionClaw

VisionClaw is an iOS app that connects your iPhone to OpoClaw. Combined with Meta Ray-Ban glasses, it gives your glasses live AI vision powered by Google Gemini.

### Requirements

- Mac with Xcode installed (https://developer.apple.com/xcode)
- iPhone running iOS 16 or later
- Apple Developer account (free tier works for personal use)
- Google Gemini API key

### Setup

1. Open the project in Xcode:
   ```
   open visionclaw/CameraAccess.xcodeproj
   ```

2. Copy the Secrets template:
   ```bash
   cp visionclaw/CameraAccess/Secrets.swift.example \
      visionclaw/CameraAccess/Secrets.swift
   ```

3. Edit `visionclaw/CameraAccess/Secrets.swift` and fill in:
   ```swift
   static let geminiAPIKey = "YOUR_GEMINI_API_KEY"

   // Optional — for agentic tool-calling from the glasses:
   // Run: scutil --get LocalHostName   to find your Mac's hostname
   static let openClawHost = "http://YOUR_MAC_HOSTNAME.local"
   static let openClawPort = 3001   // your DASHBOARD_PORT
   static let openClawHookToken = "YOUR_DASHBOARD_TOKEN"
   static let openClawGatewayToken = "YOUR_DASHBOARD_TOKEN"

   // Optional — for live POV streaming via WebRTC:
   static let webrtcSignalingURL = "ws://YOUR_MAC_IP:8080"
   ```

4. In Xcode: set your Apple ID under Signing & Capabilities > Team

5. Connect your iPhone via USB

6. Select your device in the scheme selector (top bar)

7. Product > Run (or press the play button)

8. If prompted on iPhone: Settings > General > VPN & Device Management > trust your developer certificate

### Meta Ray-Ban Glasses

When your Ray-Ban glasses take a photo, it is sent to your iPhone. VisionClaw routes it to Gemini for analysis. Your assistant responds with what it sees, either in your ear or via Telegram message.

No additional setup required for the glasses — the iPhone app handles the Bluetooth connection automatically.

---

## Cloudflare

Cloudflare Tunnel gives your dashboard a public HTTPS URL so you can access it from anywhere and so VisionClaw can connect remotely.

### Setup

1. Go to https://dash.cloudflare.com
2. Sign up for a free account if you do not have one
3. Your domain must be on Cloudflare (or use a Cloudflare-assigned `.trycloudflare.com` URL)
4. Click **Zero Trust** in the sidebar
5. Networks > Tunnels > Create a tunnel
6. Choose **Cloudflared** as connector type
7. Give the tunnel a name (e.g. "opoclaw")
8. Copy the tunnel token shown on screen
9. Set `CLOUDFLARE_TUNNEL_TOKEN` in your `.env`
10. Under Public Hostnames, add:
    - Subdomain: `dashboard` (or any name you want)
    - Domain: your domain
    - Service: `http://localhost:3001` (or your `DASHBOARD_PORT`)
11. Set `DASHBOARD_URL` in `.env` to `https://dashboard.yourdomain.com`

### Install cloudflared

```bash
# Mac
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

OpoClaw starts the tunnel automatically via PM2 if `CLOUDFLARE_TUNNEL_TOKEN` is set.
See `scripts/start-cloudflare-tunnel.sh` for the startup script.

---

## PM2

PM2 manages all OpoClaw processes and keeps them running after crashes and reboots.

### Status

```bash
pm2 list              # See all processes and their status
pm2 status            # Alias for pm2 list
```

### Logs

```bash
pm2 logs              # Stream all logs
pm2 logs opoclaw   # Logs for a specific process
pm2 logs --lines 100  # Last 100 lines
```

### Restart

```bash
pm2 restart all           # Restart all processes
pm2 restart opoclaw    # Restart a specific process
pm2 reload all            # Zero-downtime reload (for web servers)
```

### Stop and delete

```bash
pm2 stop all              # Stop all (keeps them in the list)
pm2 delete all            # Remove all from PM2 list
pm2 stop opoclaw       # Stop a specific process
```

### Start on system boot

Run this once to generate the startup command:
```bash
pm2 startup
```
Copy and run the command it outputs (starts with `sudo`). Then:
```bash
pm2 save   # Save current process list so it restores on reboot
```

### After .env changes

```bash
pm2 restart all --update-env   # Restart and reload env vars
```

### Common process names

| Name | What it is |
|------|------------|
| `opoclaw` | Main bot + scheduler |
| `dashboard-server` | React dashboard backend |
| `satoshi-bot` | Conservative trading bot |
| `nakamoto-bot` | Aggressive trading bot |
| `cruz-intelligence` | Market intelligence (runs every 4h) |
| `trading-daily-report` | Daily PDF report (runs at 7 PM) |
| `trading-watchdog` | Monitors bots and IP changes |

---

## Troubleshooting

### Bot not responding on Telegram

1. Check PM2: `pm2 list` — is `opoclaw` online?
2. Check logs: `pm2 logs opoclaw`
3. Verify the bot token: `curl "https://api.telegram.org/botYOUR_TOKEN/getMe"`
4. Make sure `ALLOWED_CHAT_ID` matches your actual Telegram user ID
5. Restart: `pm2 restart opoclaw`

### Dashboard not loading

1. Check PM2: `pm2 list` — is `dashboard-server` online?
2. Check port: `curl http://localhost:3001/health`
3. Check logs: `pm2 logs dashboard-server`
4. Verify `DASHBOARD_PORT` in `.env` matches what you are accessing
5. If you changed source files, rebuild: `bash scripts/deploy-dashboard.sh`

### "Credit balance is too low" error

You have `ANTHROPIC_API_KEY` set in `.env` while also using `claude login`. The API key takes precedence and has its own separate balance. Either:
- Remove `ANTHROPIC_API_KEY` from `.env` (OAuth will be used instead), or
- Add credits to your API account at https://console.anthropic.com/billing

### Voice notes not transcribed (sending as text instead)

- Check `GROQ_API_KEY` is set in `.env`
- Restart: `pm2 restart opoclaw --update-env`
- Check logs for `[voice]` entries: `pm2 logs opoclaw | grep voice`

### Voice responses are text instead of audio

- Check `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are both set
- Verify the Voice ID exists in your ElevenLabs account
- Check logs: `pm2 logs opoclaw | grep elevenlabs`

### Binance "invalid API key" or trading bots offline

The most common cause is an IP address change on your Mac Mini. Binance API keys have IP whitelisting:
1. Find your current IP: `curl -s ifconfig.me`
2. Go to binance.com > API Management > edit your key
3. Add the new IP to the whitelist

The `trading-watchdog` PM2 process monitors for this and will alert you via Telegram.

### Google Calendar / Gmail not working

Run the auth scripts manually:
```bash
python3 scripts/gmail-auth.py
python3 scripts/gcal-auth.py
```
If you get "access blocked", add your email as a test user in Google Cloud Console > OAuth consent screen > Test users.

### `pm2 startup` command fails

Run it without `sudo` first to get the exact command:
```bash
pm2 startup
```
Then copy and run the full `sudo env PATH=...` command it outputs.

### Port already in use

Change `DASHBOARD_PORT` (default 3001) or `BOT_INJECT_PORT` (default 3142) in `.env`, then:
```bash
pm2 restart all --update-env
```

### Cloudflare Tunnel not connecting

1. Check `cloudflared` is installed: `cloudflared --version`
2. Check `CLOUDFLARE_TUNNEL_TOKEN` is set in `.env`
3. Check PM2: `pm2 logs cloudflare-tunnel`
4. Try running manually: `cloudflared tunnel run --token YOUR_TOKEN`
5. Verify the tunnel shows as Active in Cloudflare dashboard > Zero Trust > Tunnels

### Rebuild after code changes

```bash
# Backend TypeScript
npm run build
pm2 restart all

# Dashboard frontend
bash scripts/deploy-dashboard.sh
```

---

For more, see the full README or open an issue at https://github.com/gonzaestradag/opoclaw
