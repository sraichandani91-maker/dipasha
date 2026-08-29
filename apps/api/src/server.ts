import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { pingDatabase } from "./db.js";
import { captureException } from "./lib/error-tracking.js";
import authPlugin from "./plugins/auth.js";
import activityLogPlugin from "./plugins/activity-log.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import productRoutes from "./routes/products.js";
import saltRoutes from "./routes/salts.js";
import binRoutes from "./routes/bins.js";
import searchRoutes from "./routes/search.js";
import vendorRoutes from "./routes/vendors.js";
import vendorDebitNoteRoutes from "./routes/vendor-debit-notes.js";
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
import coldChainRoutes from "./routes/cold-chain.js";
import settingsRoutes from "./routes/settings.js";
import whatsappInboundRoutes from "./routes/whatsapp-inbound.js";
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
import syncRoutes from "./routes/sync.js";
import inventoryRoutes from "./routes/inventory.js";
import chronicRoutes from "./routes/chronic.js";
import accountingRoutes from "./routes/accounting.js";
import financialSummaryRoutes from "./routes/financial-summary.js";
import ewayBillRoutes from "./routes/eway-bills.js";
import ownerDashboardRoutes from "./routes/owner-dashboard.js";

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

  // Section 12B.4 / M16: every unhandled route error passes through here
  // exactly once — a genuine 5xx (a bug, not a validation rejection) is
  // reported to Sentry and logged at error level; anything Fastify/Zod
  // already classified below 500 (bad input, auth failures, the 400s
  // routes return deliberately) is left alone, since those are expected
  // traffic, not "silent failures accumulating unnoticed." Stack traces
  // never reach the client outside development — a bug being fixable is
  // not the same as a bug being safe to expose to whoever is calling the API.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      req.log.error({ err, reqId: req.id }, "unhandled route error");
      captureException(err, { reqId: req.id, method: req.method, url: req.url });
    }
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal_server_error" : (err.code ?? "bad_request"),
      message: statusCode >= 500 && config.nodeEnv === "production" ? "Something went wrong." : err.message,
    });
  });

  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });
  app.register(authPlugin);
  app.register(activityLogPlugin);
  app.register(authRoutes);
  app.register(userRoutes);
  app.register(productRoutes);
  app.register(saltRoutes);
  app.register(binRoutes);
  app.register(searchRoutes);
  app.register(vendorRoutes);
  app.register(vendorDebitNoteRoutes);
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
  app.register(coldChainRoutes);
  app.register(settingsRoutes);
  app.register(whatsappInboundRoutes);
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
  app.register(syncRoutes);
  app.register(inventoryRoutes);
  app.register(chronicRoutes);
  app.register(accountingRoutes);
  app.register(financialSummaryRoutes);
  app.register(ewayBillRoutes);
  app.register(ownerDashboardRoutes);

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
