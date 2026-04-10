module.exports = {
  apps: [{
    name: 'runbox',
    script: 'dist/index.mjs',
    node_args: '--enable-source-maps',
    cwd: '/path/to/runbox/artifacts/api-server',
    max_restarts: 10,
    restart_delay: 3000,
    env: {
      PORT: '4001',
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      STELLAR_RECEIVE_ADDRESS: 'G_YOUR_STELLAR_ADDRESS',
      STELLAR_NETWORK: 'mainnet',
      SESSION_JWT_SECRET: 'your-long-random-secret',
      RUNBOX_PRICE: '0.01',
      RUNBOX_DEFAULT_MINUTES: '5'
    }
  }]
}
