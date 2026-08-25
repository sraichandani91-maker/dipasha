import { buildServer } from "./server.js";
import { config } from "./config.js";
import { pool } from "./db.js";

// Fail fast and loud, not on the first login attempt in front of a
// customer. A blank JWT_SECRET would otherwise sign every token with an
// empty key.
if (config.nodeEnv === "production" && !config.jwtSecret) {
  console.error("JWT_SECRET is not set. Refusing to start in production. See .env.example.");
  process.exit(1);
}

const app = buildServer();

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool?.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app
  .listen({ port: config.port, host: config.host })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
