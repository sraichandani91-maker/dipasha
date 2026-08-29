import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getOwnerHomeDashboard } from "../repo/owner-dashboard.js";
import { getCustomerDuesList } from "../repo/customers.js";
import { enqueueAndSendNow } from "../domain/notifications.js";

/**
 * Owner-requested Home dashboard (a competitor pharmacy-retail app
 * screenshot, asked to be recreated on the web console) — Owner-only,
 * same bar as Financials/Margins, never the staff console.
 */
export default async function ownerDashboardRoutes(app: FastifyInstance) {
  const guard = { preHandler: [app.authenticate, app.requireRole("owner")] };

  app.get("/owner-dashboard", guard, async (req, reply) => {
    const q = z.object({ from: z.string(), to: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    reply.send(await getOwnerHomeDashboard(q.data.from, q.data.to));
  });

  // "remind now" on a Due Payments > Customer row — the same manual-send
  // shape as chronic.ts's sendReminderNow, just for an outstanding
  // balance instead of a refill.
  app.post("/customers/:id/remind-due", guard, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id" });

    const dues = await getCustomerDuesList();
    const due = dues.find((d) => d.customerId === params.data.id);
    if (!due) return reply.code(404).send({ error: "no_outstanding_balance" });
    if (!due.phone) return reply.code(409).send({ error: "no_customer_phone" });

    const result = await enqueueAndSendNow(
      {
        triggerType: "payment_due_reminder",
        category: "transactional",
        templateKey: "whatsapp_template_payment_due_reminder",
        triggerEnabledSettingKey: "whatsapp_trigger_payment_due_reminder_enabled",
        recipientCustomerId: params.data.id,
        recipientPhone: due.phone,
        referenceType: "customer_due",
        referenceId: params.data.id,
        payload: { customerName: due.name, amountDue: due.totalDue, dueDate: due.dueDate },
      },
      req.log
    );
    reply.send(result);
  });
}
