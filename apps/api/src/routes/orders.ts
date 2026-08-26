import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { saveUploadedPhoto, resolveUploadPath, UploadError } from "../lib/uploads.js";
import {
  createOrder, getOrder, listPendingOrders, listActiveOrders, addOrderLine, resolveOrderLine,
  addOrderImage, getOrderImageFilePath, logOrderImageView, addOrderMessage, findSubstitutesForProduct, sendQuote,
  recordCustomerConfirmed, recordCustomerDeclined, verifyPrescription, OrderError,
} from "../repo/orders.js";
import {
  startPicking, confirmPickLine, markPickLineShort, applySubstituteForShortfall, completePicking,
  packScan, completePacking, PickingError,
} from "../repo/order-picking.js";

const CONTENT_TYPE_BY_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

const catalogLineSchema = z.object({ productId: z.string().uuid(), quantityRequestedUnits: z.coerce.number().int().positive() });

const createOrderSchema = z.object({
  customerName: z.string().min(1),
  customerPhone: z.string().min(1),
  deliveryAddress: z.string().nullable().optional(),
  deliveryPincode: z.string().nullable().optional(),
  freeTextNote: z.string().nullable().optional(),
  catalogLines: z.string().optional(), // JSON-encoded array, since this arrives as a multipart form field alongside optional images
  deliveryCharge: z.coerce.number().min(0).default(0),
  deviceId: z.string().min(1),
});

/**
 * Section 7 delivery channel (order entry, pick list, packing verify) and
 * Section 7A unstructured-order intake / review / quote. Customer-app
 * screens are out of scope (Section 2) — everything here is the API and
 * staff-side handling, per M10's own build-order bullet.
 */
export default async function orderRoutes(app: FastifyInstance) {
  // multipart because of the optional prescription/strip photos — same
  // pattern as write-offs.ts. Section 7A.1: "mixed orders are essential" —
  // catalogue lines, free text, and images can all arrive on one order.
  app.post("/orders", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const fields: Record<string, string> = {};
    const images: Array<{ filePath: string; kind: "prescription" | "strip_photo" | "other" }> = [];
    // The client sends one "imageKind" field immediately before each
    // "image" file part, in stream order — @fastify/multipart parts()
    // has no built-in way to associate a sibling field with a specific
    // file part, so this is the ordering contract between client and
    // server (same shape purchase entry already uses for per-line fields).
    let pendingImageKind: "prescription" | "strip_photo" | "other" = "other";

    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "image") {
          part.file.resume();
          continue;
        }
        try {
          const filePath = await saveUploadedPhoto(part);
          images.push({ filePath, kind: pendingImageKind });
          pendingImageKind = "other";
        } catch (err) {
          if (err instanceof UploadError) return reply.code(400).send({ error: err.code });
          throw err;
        }
      } else if (part.fieldname === "imageKind") {
        const v = String(part.value);
        pendingImageKind = v === "prescription" || v === "strip_photo" ? v : "other";
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const parsed = createOrderSchema.safeParse(fields);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;

    let catalogLines: z.infer<typeof catalogLineSchema>[] = [];
    if (b.catalogLines) {
      try {
        const rawLines = JSON.parse(b.catalogLines);
        const linesParsed = z.array(catalogLineSchema).safeParse(rawLines);
        if (!linesParsed.success) return reply.code(400).send({ error: "invalid_catalog_lines" });
        catalogLines = linesParsed.data;
      } catch {
        return reply.code(400).send({ error: "invalid_catalog_lines_json" });
      }
    }

    try {
      const result = await createOrder({
        customerName: b.customerName,
        customerPhone: b.customerPhone,
        deliveryAddress: b.deliveryAddress ?? null,
        deliveryPincode: b.deliveryPincode ?? null,
        freeTextNote: b.freeTextNote ?? null,
        catalogLines,
        imagePaths: images,
        deliveryCharge: b.deliveryCharge,
        createdBy: req.auth!.sub,
        deviceId: b.deviceId,
        source: "web",
      });
      reply.code(201).send(result);
    } catch (err) {
      if (err instanceof OrderError) return reply.code(409).send({ error: err.code, details: err.details });
      throw err;
    }
  });

  app.get("/orders/pending", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (_req, reply) => {
    reply.send(await listPendingOrders());
  });

  app.get(
    "/orders/active",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (_req, reply) => {
      reply.send(await listActiveOrders());
    }
  );

  app.get(
    "/orders/:id",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer", "rider")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      const result = await getOrder(params.data.id);
      if (!result) return reply.code(404).send({ error: "not_found" });
      // A rider may only view an order actually assigned to them — role
      // alone isn't enough here, unlike every other role check in this
      // route file (Section 8: "sees assigned trips only").
      if (req.auth!.role === "rider" && result.order.rider_id !== req.auth!.sub) {
        return reply.code(403).send({ error: "not_assigned_to_you" });
      }
      reply.send(result);
    }
  );

  app.post(
    "/orders/:id/lines",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ sourceType: z.enum(["free_text", "image"]), descriptionAsEntered: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const result = await addOrderLine(params.data.id, { ...body.data, createdBy: req.auth!.sub });
        reply.code(201).send(result);
      } catch (err) {
        if (err instanceof OrderError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  const resolveLineSchema = z.object({
    action: z.enum(["match", "substitute", "unavailable", "push_to_request_book"]),
    productId: z.string().uuid().optional(),
    quantityConfirmedUnits: z.coerce.number().int().positive().optional(),
    unavailableReason: z.string().optional(),
    deviceId: z.string().min(1),
  });
  app.post(
    "/orders/:id/lines/:lineId/resolve",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid(), lineId: z.string().uuid() }).safeParse(req.params);
      const body = resolveLineSchema.safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await resolveOrderLine(params.data.id, params.data.lineId, { ...body.data, loggedBy: req.auth!.sub });
        reply.send({ resolved: true });
      } catch (err) {
        if (err instanceof OrderError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  app.get(
    "/orders/products/:productId/substitutes",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ productId: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      reply.send(await findSubstitutesForProduct(params.data.productId));
    }
  );

  // Section 7A.5: staff can request another photo mid-review.
  app.post("/orders/:id/images", { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });
    let saved: { filePath: string; kind: "prescription" | "strip_photo" | "other" } | null = null;
    let pendingKind: "prescription" | "strip_photo" | "other" = "other";
    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "image") {
        try {
          const filePath = await saveUploadedPhoto(part);
          saved = { filePath, kind: pendingKind };
        } catch (err) {
          if (err instanceof UploadError) return reply.code(400).send({ error: err.code });
          throw err;
        }
      } else if (part.type === "file") {
        part.file.resume();
      } else if (part.fieldname === "kind") {
        const v = String(part.value);
        pendingKind = v === "prescription" || v === "strip_photo" ? v : "other";
      }
    }
    if (!saved) return reply.code(400).send({ error: "no_image" });
    const result = await addOrderImage(params.data.id, { ...saved, uploadedBy: req.auth!.sub });
    reply.code(201).send(result);
  });

  // Section 7A.4: "restrict access to Owner, Manager and pharmacist
  // roles... and log every view." No distinct pharmacist role exists in
  // this build (Section 3's role table), so this uses owner/store_manager
  // — the same call already made for who bills at the counter.
  app.get(
    "/orders/images/:imageId",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ imageId: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      const storedFilename = await getOrderImageFilePath(params.data.imageId);
      if (!storedFilename) return reply.code(404).send({ error: "not_found" });
      const filePath = resolveUploadPath(storedFilename);
      if (!filePath) return reply.code(400).send({ error: "invalid_filename" });
      try {
        const buf = await readFile(filePath);
        await logOrderImageView(params.data.imageId, req.auth!.sub);
        const ext = storedFilename.split(".").pop()!.toLowerCase();
        reply.type(CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream").send(buf);
      } catch {
        reply.code(404).send({ error: "not_found" });
      }
    }
  );

  app.post(
    "/orders/:id/messages",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ sender: z.enum(["customer", "staff"]), body: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      const result = await addOrderMessage(params.data.id, { ...body.data, createdBy: req.auth!.sub });
      reply.code(201).send(result);
    }
  );

  app.post(
    "/orders/:id/quote",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ deliveryCharge: z.coerce.number().min(0) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        reply.send(await sendQuote(params.data.id, { deliveryCharge: body.data.deliveryCharge, staffUserId: req.auth!.sub }));
      } catch (err) {
        if (err instanceof OrderError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  // Section 7A.3: "Only on acceptance does the order enter picking and
  // stock get reserved." No customer app / WhatsApp inbound exists in
  // this build (both out of scope / M13) — staff records the customer's
  // acceptance after hearing it by phone or a relayed WhatsApp reply.
  app.post(
    "/orders/:id/confirm",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      try {
        await recordCustomerConfirmed(params.data.id);
        reply.send({ confirmed: true });
      } catch (err) {
        if (err instanceof OrderError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  app.post(
    "/orders/:id/decline",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ reason: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await recordCustomerDeclined(params.data.id, body.data.reason);
        reply.send({ declined: true });
      } catch (err) {
        if (err instanceof OrderError) return reply.code(409).send({ error: err.code });
        throw err;
      }
    }
  );

  app.post(
    "/orders/:id/verify-prescription",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      await verifyPrescription(params.data.id, req.auth!.sub);
      reply.send({ verified: true });
    }
  );

  app.post(
    "/orders/:id/start-picking",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      try {
        reply.send(await startPicking(params.data.id, req.auth!.sub));
      } catch (err) {
        if (err instanceof PickingError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/orders/pick-lines/:pickLineId/confirm",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ pickLineId: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ scannedBatchNo: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await confirmPickLine(params.data.pickLineId, body.data.scannedBatchNo);
        reply.send({ confirmed: true });
      } catch (err) {
        if (err instanceof PickingError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/orders/pick-lines/:pickLineId/short",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ pickLineId: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ actualFound: z.coerce.number().int().min(0), shortReason: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        reply.send(await markPickLineShort(params.data.pickLineId, body.data));
      } catch (err) {
        if (err instanceof PickingError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/orders/:id/pick-lines/:pickLineId/substitute",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid(), pickLineId: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ newProductId: z.string().uuid(), shortfallQuantity: z.coerce.number().int().positive() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await applySubstituteForShortfall(params.data.id, params.data.pickLineId, body.data.newProductId, body.data.shortfallQuantity);
        reply.send({ substituted: true });
      } catch (err) {
        if (err instanceof PickingError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/orders/:id/complete-picking",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });
      try {
        await completePicking(params.data.id);
        reply.send({ picked: true });
      } catch (err) {
        if (err instanceof PickingError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/orders/pick-lines/:pickLineId/pack-scan",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ pickLineId: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ scannedProductId: z.string().uuid() }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        await packScan(params.data.pickLineId, body.data.scannedProductId);
        reply.send({ confirmed: true });
      } catch (err) {
        if (err instanceof PickingError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );

  app.post(
    "/orders/:id/complete-packing",
    { preHandler: [app.authenticate, app.requireRole("owner", "store_manager", "picker_packer")] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      const body = z.object({ deviceId: z.string().min(1) }).safeParse(req.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        reply.send(await completePacking(params.data.id, req.auth!.sub, body.data.deviceId));
      } catch (err) {
        if (err instanceof PickingError) return reply.code(409).send({ error: err.code, details: err.details });
        throw err;
      }
    }
  );
}
