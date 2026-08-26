import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
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
import salesRoutes from "./routes/sales.js";
import stockIssueRoutes from "./routes/stock-issue.js";
import returnsRoutes from "./routes/returns.js";
import dayCloseRoutes from "./routes/day-close.js";
import reportRoutes from "./routes/reports.js";
import requestRoutes from "./routes/requests.js";
import purchaseOrderRoutes from "./routes/purchase-orders.js";
import cycleCountRoutes from "./routes/cycle-counts.js";
import expiryAuditRoutes from "./routes/expiry-audit.js";
import writeOffRoutes from "./routes/write-offs.js";
import statutoryReportRoutes from "./routes/statutory-reports.js";
import prescriberRoutes from "./routes/prescribers.js";
import marginReportRoutes from "./routes/margin-reports.js";
import customerRoutes from "./routes/customers.js";
import vendorComparisonRoutes from "./routes/vendor-comparison.js";
import notificationRoutes from "./routes/notifications.js";
import purchaseScanRoutes from "./routes/purchase-scans.js";
import orderRoutes from "./routes/orders.js";
import deliveryRoutes from "./routes/delivery.js";

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

  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });
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
  app.register(salesRoutes);
  app.register(stockIssueRoutes);
  app.register(returnsRoutes);
  app.register(dayCloseRoutes);
  app.register(reportRoutes);
  app.register(requestRoutes);
  app.register(purchaseOrderRoutes);
  app.register(cycleCountRoutes);
  app.register(expiryAuditRoutes);
  app.register(writeOffRoutes);
  app.register(statutoryReportRoutes);
  app.register(prescriberRoutes);
  app.register(marginReportRoutes);
  app.register(customerRoutes);
  app.register(vendorComparisonRoutes);
  app.register(notificationRoutes);
  app.register(purchaseScanRoutes);
  app.register(orderRoutes);
  app.register(deliveryRoutes);

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
