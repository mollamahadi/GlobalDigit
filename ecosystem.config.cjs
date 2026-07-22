module.exports = {
  apps: [{
    name: "global-digits-bot",
    script: "src/index.js",
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    time: true,
    env: {
      NODE_ENV: "production"
    }
  }]
};
