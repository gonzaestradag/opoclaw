module.exports = {
  apps: [{
    name: 'opo-scalper',
    script: '/Users/opoclaw1/claudeclaw/src/opo-scalper.cjs',
    cwd: '/Users/opoclaw1/claudeclaw',
    interpreter: 'node',
    restart_delay: 10000,    // 10s before restart — WS reconnect handles short blips
    max_restarts: 100,       // High limit — 24/7 operation
    min_uptime: '20s',       // Must run 20s to count as stable
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/Users/opoclaw1/claudeclaw/logs/opo-scalper-pm2-error.log',
    out_file:   '/Users/opoclaw1/claudeclaw/logs/opo-scalper-pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
