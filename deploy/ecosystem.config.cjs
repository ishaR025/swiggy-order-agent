module.exports = {
  apps: [
    {
      name: "swiggy-order-agent",
      script: "dist/index.js",
      cwd: __dirname + "/..",
      restart_delay: 5000,
      max_restarts: 20,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
