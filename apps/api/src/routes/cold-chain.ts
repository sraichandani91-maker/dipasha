import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { recordTemperature, listTemperatureLogs, checkTemperatureGap } from "../repo/cold-chain.js";

const recordSchema = z.object({
  temperatureCelsius: z.number(),
  note: z.string().nullable().optional(),
  deviceId: z.string().min(1),
});

/**
 * Section 9 / Section 10.2: cold-chain temperature log + gap alerts. Any
 * staff role can log a reading (whoever opens the fridge); reviewing the
 * log and gap status is open to everyone too — this is a safety record,
 * not a financial one.
 */
export default async function coldChainRoutes(app: FastifyInstance) {
  app.post("/cold-chain/temperature-logs", { preHandler: app.authenticate }, async (req, reply) => {
    const body = recordSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", details: body.error.flatten() });
    const result = await recordTemperature({
      temperatureCelsius: body.data.temperatureCelsius,
      note: body.data.note ?? null,
      recordedBy: req.auth!.sub,
      deviceId: body.data.deviceId,
      source: "web",
    });
    reply.code(201).send(result);
  });

  app.get("/cold-chain/temperature-logs", { preHandler: app.authenticate }, async (req, reply) => {
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await listTemperatureLogs(query.data));
  });

  app.get("/cold-chain/gap-check", { preHandler: app.authenticate }, async (_req, reply) => {
    reply.send(await checkTemperatureGap());
  });
}
