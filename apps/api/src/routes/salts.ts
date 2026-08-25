import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { searchSalts } from "../repo/salts.js";

export default async function saltRoutes(app: FastifyInstance) {
  // Backs the salt-master autocomplete used when typing a composition
  // (Section 6B.2) — same trigram approach the unified search (Section
  // 5B) uses.
  app.get("/salts", { preHandler: app.authenticate }, async (req, reply) => {
    const parsed = z.object({ q: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "missing_query", param: "q" });
    reply.send(await searchSalts(parsed.data.q));
  });
}
