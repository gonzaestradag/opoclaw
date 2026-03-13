#!/usr/bin/env bash
# deploy-dashboard.sh — Build dashboard and restart server
# Run this after ANY change to dashboard/src/** or src/dashboard-server.ts

set -e

echo "[deploy] Compiling backend TypeScript..."
cd /Users/opoclaw1/claudeclaw
npm run build

echo "[deploy] Building dashboard..."
cd /Users/opoclaw1/claudeclaw/dashboard
npm run build

echo "[deploy] Restarting dashboard-server..."
pm2 restart dashboard-server

echo "[deploy] Done. Changes are live at http://localhost:3001 and via Cloudflare Tunnel."
