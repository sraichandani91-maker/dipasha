import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import { pingDatabase } from "./db.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import productRoutes from "./routes/products.js";
import saltRoutes from "./routes/salts.js";
import binRoutes from "./routes/bins.js";
import searchRoutes from "./routes/search.js";
import vendorRoutes from "./routes/vendors.js";
import purchaseRoutes from "./routes/purchases.js";
import stockMovementRoutes from "./routes/stock-movements.js";
import putawayRoutes from "./routes/putaway.js";

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

  app.register(authPlugin);
  app.register(authRoutes);
  app.register(productRoutes);
  app.register(saltRoutes);
  app.register(binRoutes);
  app.register(searchRoutes);
  app.register(vendorRoutes);
  app.register(purchaseRoutes);
  app.register(stockMovementRoutes);
  app.register(putawayRoutes);

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
