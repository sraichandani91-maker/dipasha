import fp from "fastify-plugin";
import { recordActivity, touchLastSeen } from "../repo/activity-log.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Section 10.2's per-user activity log ("every action that user has
 * taken") is populated here, once, generically — a single onResponse
 * hook covering every route in the app — rather than a call added by
 * hand inside each route handler. That's the only way "every action" is
 * actually true instead of "every action someone remembered to log."
 *
 * Reads (GET) don't get a row in activity_log — logging every page load
 * and poll would bury the real audit trail in noise nobody asked to see
 * (Section 10.2 talks about actions, not views) — but every authenticated
 * request, GET included, still updates user_last_seen so the roster's
 * "logged in now" reflects real browsing, not just mutations.
 */
export default fp(async (app) => {
  app.addHook("onResponse", async (req, reply) => {
    if (!req.auth) return;
    void touchLastSeen(req.auth.sub).catch((err) => app.log.error({ err }, "touchLastSeen failed"));
    if (!MUTATING_METHODS.has(req.method)) return;
    void recordActivity({
      userId: req.auth.sub,
      method: req.method,
      path: req.url,
      route: req.routeOptions?.url ?? null,
      statusCode: reply.statusCode,
    }).catch((err) => app.log.error({ err }, "recordActivity failed"));
  });
});
