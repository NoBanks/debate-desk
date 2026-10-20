// PM2 entry for Debate Desk (devnet). Crash-loop guards are mandatory: do not remove.
// Windows note: PM2 cannot run .cmd shims, and on Windows it does not capture output from tsx's
// spawned child. So node runs the TypeScript itself in ONE process, with tsx as an import hook.
// Bring up from this file; never pm2-save without Ryan's say-so.
const path = require("node:path");
module.exports = {
  apps: [
    {
      name: "debate-desk",
      script: path.join(__dirname, "src", "desk.ts"),
      args: "loop",
      interpreter: "node",
      node_args: "--import tsx",
      cwd: __dirname,
      env: { DESK_AUTOPUBLISH: "1", CYCLE_SECONDS: "900" },
      autorestart: true,
      max_restarts: 10,
      min_uptime: 30000,
      exp_backoff_restart_delay: 2000,
      restart_delay: 5000,
      max_memory_restart: "400M",
    },
  ],
};
