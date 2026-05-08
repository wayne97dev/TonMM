module.exports = {
  apps: [
    {
      name: "tonmm",
      script: "dist/index.js",
      cwd: __dirname,
      // Single-instance: il pool wallet ha una coda seqno per-wallet,
      // piu' istanze provocherebbero collisioni.
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_memory_restart: "512M",
      // Se il processo crasha in loop, pm2 aspetta 5s e ritenta
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
      // I log di pm2 - utile soprattutto per debug iniziale
      out_file: "data/pm2-out.log",
      error_file: "data/pm2-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
