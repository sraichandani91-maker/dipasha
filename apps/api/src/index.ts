import { buildServer } from "./server.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { processPendingNotifications } from "./domain/notifications.js";
import { generateDailyReportIfDue } from "./repo/reports.js";

// Fail fast and loud, not on the first login attempt in front of a
// customer. A blank JWT_SECRET would otherwise sign every token with an
// empty key.
if (config.nodeEnv === "production" && !config.jwtSecret) {
  console.error("JWT_SECRET is not set. Refusing to start in production. See .env.example.");
  process.exit(1);
}

const app = buildServer();

// Section 12A: the WhatsApp dispatcher's queue processor. No background
// job runner exists in this build (see M5's DECISIONS.md note on
// reservation-expiry sweeping) — this is a plain `setInterval` in the
// same process, a Postgres-backed queue polled by whoever's running,
// which is the pragmatic "optimise for one person maintaining it" choice
// for a single-VPS pilot. If this ever runs as more than one API
// instance, only one instance should run this poller (or it moves to a
// real queue) — same caveat as local-disk upload storage elsewhere.
const NOTIFICATION_POLL_INTERVAL_MS = 15_000;
const notificationInterval = config.databaseUrl
  ? setInterval(() => {
      processPendingNotifications(app.log).catch((err) => app.log.error(err, "notification dispatcher tick failed"));
    }, NOTIFICATION_POLL_INTERVAL_MS)
  : null;

// Section 10.2's daily auto-report — same poller pattern as the
// notification dispatcher above, on a coarser interval since it only
// ever needs to fire once per business date.
const DAILY_REPORT_POLL_INTERVAL_MS = 5 * 60_000;
const dailyReportInterval = config.databaseUrl
  ? setInterval(() => {
      generateDailyReportIfDue(app.log).catch((err) => app.log.error(err, "daily report tick failed"));
    }, DAILY_REPORT_POLL_INTERVAL_MS)
  : null;

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  if (notificationInterval) clearInterval(notificationInterval);
  if (dailyReportInterval) clearInterval(dailyReportInterval);
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
