module.exports = {
  apps: [{
    name: 'opo-trader',
    script: '/Users/opoclaw1/opoclaw/src/opo-trader.cjs',
    cwd: '/Users/opoclaw1/opoclaw',
    interpreter: 'node',
    restart_delay: 15000,    // Wait 15s before restart on crash
    max_restarts: 50,        // Allow many restarts for 24/7 operation
    min_uptime: '30s',       // Must run 30s to count as stable
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/Users/opoclaw1/opoclaw/logs/opo-trader-pm2-error.log',
    out_file: '/Users/opoclaw1/opoclaw/logs/opo-trader-pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
