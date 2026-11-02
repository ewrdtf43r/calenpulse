module.exports = {
  apps: [
    {
      name: 'calenpulse',
      script: 'src/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '8787',
      },
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
