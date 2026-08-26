import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createPrescriber,
  listPrescribers,
  moleculesByPrescriber,
  newPrescribersInRange,
  prescribersWithDroppedVolume,
  salesByPrescriber,
  searchPrescribers,
} from "../repo/prescribers.js";

const createPrescriberSchema = z.object({
  name: z.string().min(1),
  registrationNumber: z.string().nullable().optional(),
  speciality: z.string().nullable().optional(),
  clinicOrHospital: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

/**
 * Section 9A.1 — prescriber master, autocomplete, and the "commercial
 * intelligence" reports. Privacy: this data links patients to
 * prescriptions, so every route here is Owner/Store Manager only, same
 * bar as everywhere else patient-adjacent data appears.
 */
export default async function prescriberRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner", "store_manager")] };

  app.post("/prescribers", guard, async (req, reply) => {
    const parsed = createPrescriberSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;
    const result = await createPrescriber({
      name: b.name,
      registrationNumber: b.registrationNumber ?? null,
      speciality: b.speciality ?? null,
      clinicOrHospital: b.clinicOrHospital ?? null,
      phone: b.phone ?? null,
      address: b.address ?? null,
    });
    reply.code(201).send(result);
  });

  app.get("/prescribers", guard, async (req, reply) => {
    const q = z.object({ search: z.string().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(q.data.search ? await searchPrescribers(q.data.search) : await listPrescribers());
  });

  const dateRangeSchema = z.object({ from: z.string(), to: z.string() });

  app.get("/prescribers/reports/sales-by-prescriber", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await salesByPrescriber(q.data.from, q.data.to));
  });

  app.get("/prescribers/:id/reports/molecules", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const q = dateRangeSchema.safeParse(req.query);
    if (!params.success || !q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await moleculesByPrescriber(params.data.id, q.data.from, q.data.to));
  });

  app.get("/prescribers/reports/new-this-range", guard, async (req, reply) => {
    const q = dateRangeSchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await newPrescribersInRange(q.data.from, q.data.to));
  });

  app.get("/prescribers/reports/dropped-volume", guard, async (req, reply) => {
    const q = z.object({ windowDays: z.coerce.number().int().positive().default(30) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await prescribersWithDroppedVolume(q.data.windowDays));
  });
}
