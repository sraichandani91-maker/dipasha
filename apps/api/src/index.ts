import { buildServer } from "./server.js";
import { config } from "./config.js";
import { pool } from "./db.js";

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
