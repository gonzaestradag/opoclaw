#!/bin/bash
# Trading Bot Control Script
# Usage: ./scripts/trading-bot.sh [start|stop|restart|status|logs]

CMD=${1:-status}
BOT_NAME="trading-bot"
BOT_SCRIPT="/Users/opoclaw1/claudeclaw/dist/trading/bot.js"

case "$CMD" in
  start)
    echo "Starting $BOT_NAME..."
    pm2 start "$BOT_SCRIPT" \
      --name "$BOT_NAME" \
      --interpreter node \
      --cwd /Users/opoclaw1/claudeclaw \
      --log /Users/opoclaw1/claudeclaw/logs/trading/pm2.log \
      --time
    pm2 save
    echo "Bot started. Run './scripts/trading-bot.sh logs' to tail logs."
    ;;
  stop)
    echo "Stopping $BOT_NAME..."
    pm2 stop $BOT_NAME
    echo "Done."
    ;;
  restart)
    echo "Restarting $BOT_NAME..."
    pm2 restart $BOT_NAME
    echo "Done."
    ;;
  status)
    pm2 show $BOT_NAME 2>/dev/null || echo "Bot is NOT running. Use 'start' to launch it."
    ;;
  logs)
    tail -f /Users/opoclaw1/claudeclaw/logs/trading/bot.log
    ;;
  delete)
    pm2 delete $BOT_NAME 2>/dev/null
    echo "Bot removed from PM2."
    ;;
  *)
    echo "Usage: $0 [start|stop|restart|status|logs|delete]"
    ;;
esac
