import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import { pingDatabase } from "./db.js";

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        config.nodeEnv === "development"
          ? { target: "pino-pretty" }
          : undefined,
    },
  });

  // Liveness/readiness probe. M1 will add auth, role checks, and real
  // business endpoints behind this same server instance.
  app.get("/health", async (_req, reply) => {
    const dbOk = await pingDatabase().catch(() => false);
    const body = {
      status: dbOk || !config.databaseUrl ? "ok" : "degraded",
      service: "dipasha-api",
      env: config.nodeEnv,
      database: config.databaseUrl ? (dbOk ? "connected" : "unreachable") : "not_configured",
      timestamp: new Date().toISOString(),
    };
    reply.code(body.status === "ok" ? 200 : 503).send(body);
  });

  app.get("/", async () => ({
    service: "dipasha-api",
    message: "Dipasha Medical Store operations API. See /health.",
  }));

  return app;
}
