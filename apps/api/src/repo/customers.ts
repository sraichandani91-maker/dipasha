import { pool } from "../db.js";
import { parseCsv } from "../lib/csv.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

// Quick-attach by phone with a lookup of past purchases (Section 6A.4).
// Credit limits, ageing, and statements are below, M7 (Section 9A.4) —
// the full customer ledger/statement generalisation for ALL customers
// (not just credit ones) is still 10B.1/M15, not this.
export async function findCustomerByPhone(phone: string): Promise<Customer | null> {
  const { rows } = await requirePool().query(`SELECT id, name, phone FROM customers WHERE phone = $1 LIMIT 1`, [phone]);
  return rows[0] ?? null;
}

export async function findOrCreateCustomer(name: string, phone: string | null): Promise<Customer> {
  if (phone) {
    const existing = await findCustomerByPhone(phone);
    if (existing) return existing;
  }
  const { rows } = await requirePool().query(`INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id, name, phone`, [name, phone]);
  return rows[0];
}

export async function getRecentPurchases(customerId: string, limit = 10) {
  const { rows } = await requirePool().query(
    `SELECT s.id, s.bill_number, s.grand_total, s.created_at
     FROM sales s WHERE s.customer_id = $1 AND s.status = 'completed'
     ORDER BY s.created_at DESC LIMIT $2`,
    [customerId, limit]
  );
  return rows;
}

export async function searchCustomers(query: string, limit = 10) {
  const { rows } = await requirePool().query(
    `SELECT id, name, phone, credit_enabled, credit_limit, account_customer_id,
       whatsapp_transactional_opt_in, whatsapp_marketing_opt_in
     FROM customers
     WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT $2`,
    [`%${query}%`, limit]
  );
  return rows;
}

// Section 12A.5: "store consent per customer per category." No inbound
// WhatsApp webhook exists yet to auto-process a customer's own STOP
// reply (that's M13's shared inbox) — until then this is how staff
// record a customer's stated preference.
export async function updateWhatsAppConsent(customerId: string, input: { transactionalOptIn: boolean; marketingOptIn: boolean }) {
  const { rows } = await requirePool().query(
    `UPDATE customers SET whatsapp_transactional_opt_in = $1, whatsapp_marketing_opt_in = $2 WHERE id = $3 RETURNING id`,
    [input.transactionalOptIn, input.marketingOptIn, customerId]
  );
  if (!rows[0]) throw new CustomerError("customer_not_found");
}

export class CustomerError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface UpdateCreditSettingsInput {
  creditEnabled: boolean;
  creditLimit: number | null;
  paymentTermsDays: number;
  accountCustomerId: string | null; // Section 9A.4 family grouping
}

export async function updateCreditSettings(customerId: string, input: UpdateCreditSettingsInput) {
  if (input.accountCustomerId === customerId) throw new CustomerError("cannot_be_own_account_holder");
  if (input.accountCustomerId) {
    // One level only (Section 9A.4 doesn't describe nested family
    // chains) — the chosen account holder must not itself be billing to
    // someone else's account.
    const { rows } = await requirePool().query(`SELECT account_customer_id FROM customers WHERE id = $1`, [input.accountCustomerId]);
    if (!rows[0]) throw new CustomerError("account_holder_not_found");
    if (rows[0].account_customer_id) throw new CustomerError("account_holder_is_itself_a_family_member");
  }
  await requirePool().query(
    `UPDATE customers SET credit_enabled = $1, credit_limit = $2, payment_terms_days = $3, account_customer_id = $4 WHERE id = $5`,
    [input.creditEnabled, input.creditLimit, input.paymentTermsDays, input.accountCustomerId, customerId]
  );
}

// Section 9A.4: "running balance shown to the biller before the sale
// completes." Resolves family grouping — a member's balance IS the
// account holder's balance, since they share one limit.
export async function getCustomerBalance(customerId: string) {
  const db = requirePool();
  const { rows: custRows } = await db.query(`SELECT id, name, credit_enabled, credit_limit, account_customer_id FROM customers WHERE id = $1`, [customerId]);
  const customer = custRows[0];
  if (!customer) throw new CustomerError("customer_not_found");
  const accountHolderId = customer.account_customer_id ?? customer.id;
  const { rows: holderRows } = await db.query(`SELECT id, name, credit_enabled, credit_limit FROM customers WHERE id = $1`, [accountHolderId]);
  const holder = holderRows[0];

  const { rows } = await db.query(
    `
    WITH credit_sales AS (
      SELECT s.id, COALESCE(SUM(st.amount) FILTER (WHERE st.tender_type = 'credit'), 0) AS credit_amount
      FROM sales s LEFT JOIN sale_tenders st ON st.sale_id = s.id
      WHERE s.customer_id IN (SELECT id FROM customers WHERE id = $1 OR account_customer_id = $1) AND s.status = 'completed'
      GROUP BY s.id
    ),
    allocations AS (
      SELECT sale_id, SUM(amount_allocated) AS allocated FROM customer_payment_allocations GROUP BY sale_id
    )
    SELECT COALESCE(SUM(cs.credit_amount - COALESCE(a.allocated, 0)), 0)::numeric(14,2) AS balance
    FROM credit_sales cs LEFT JOIN allocations a ON a.sale_id = cs.id
    WHERE cs.credit_amount > 0
    `,
    [accountHolderId]
  );

  const balance = Number(rows[0].balance);
  const creditLimit = holder.credit_limit === null ? null : Number(holder.credit_limit);
  return {
    accountHolderId,
    accountHolderName: holder.name,
    creditEnabled: holder.credit_enabled,
    creditLimit,
    balance,
    availableCredit: creditLimit === null ? null : Math.round((creditLimit - balance) * 100) / 100,
    overLimit: creditLimit !== null && balance > creditLimit,
  };
}

// Ageing buckets each unpaid credit sale by its own age from
// business_date — current / 30 / 60 / 90+ (Section 9A.4). Grouped by
// account holder, so a family's several members roll up to one row.
export async function getAgeingReport() {
  const { rows } = await requirePool().query(`
    WITH credit_sales AS (
      SELECT s.id, s.business_date, s.bill_number,
        COALESCE(cust.account_customer_id, cust.id) AS account_holder_id,
        COALESCE(SUM(st.amount) FILTER (WHERE st.tender_type = 'credit'), 0) AS credit_amount
      FROM sales s
      JOIN customers cust ON cust.id = s.customer_id
      LEFT JOIN sale_tenders st ON st.sale_id = s.id
      WHERE s.status = 'completed'
      GROUP BY s.id, cust.account_customer_id, cust.id
    ),
    allocations AS (
      SELECT sale_id, SUM(amount_allocated) AS allocated FROM customer_payment_allocations GROUP BY sale_id
    ),
    outstanding AS (
      SELECT cs.account_holder_id, cs.business_date,
        (cs.credit_amount - COALESCE(a.allocated, 0))::numeric(14,2) AS outstanding
      FROM credit_sales cs LEFT JOIN allocations a ON a.sale_id = cs.id
      WHERE cs.credit_amount > 0 AND (cs.credit_amount - COALESCE(a.allocated, 0)) > 0.005
    )
    SELECT c.id AS customer_id, c.name, c.credit_limit,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.business_date <= 30), 0)::numeric(14,2) AS current_bucket,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.business_date > 30 AND CURRENT_DATE - o.business_date <= 60), 0)::numeric(14,2) AS bucket_30,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.business_date > 60 AND CURRENT_DATE - o.business_date <= 90), 0)::numeric(14,2) AS bucket_60,
      COALESCE(SUM(o.outstanding) FILTER (WHERE CURRENT_DATE - o.business_date > 90), 0)::numeric(14,2) AS bucket_90_plus,
      COALESCE(SUM(o.outstanding), 0)::numeric(14,2) AS total_outstanding
    FROM customers c
    JOIN outstanding o ON o.account_holder_id = c.id
    WHERE c.account_customer_id IS NULL
    GROUP BY c.id, c.name, c.credit_limit
    HAVING COALESCE(SUM(o.outstanding), 0) > 0.005
    ORDER BY total_outstanding DESC
  `);
  return rows;
}

export interface RecordPaymentInput {
  customerId: string; // account holder
  amount: number;
  paymentMethod: "cash" | "upi" | "card" | "cheque" | "bank_transfer";
  referenceNumber: string | null;
  note: string | null;
  allocateToSaleId: string | null; // null = oldest-first
  receivedBy: string;
  deviceId: string;
}

// Section 9A.4: "allocated to specific bills or oldest-first." Written
// once, at record time — see the M7 migration comment on
// customer_payment_allocations for why ageing never has to recompute
// this later.
export async function recordPayment(input: RecordPaymentInput) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const { rows: paymentRows } = await client.query(
      `INSERT INTO customer_payments (customer_id, amount, payment_method, reference_number, note, received_by, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.customerId, input.amount, input.paymentMethod, input.referenceNumber, input.note, input.receivedBy, input.deviceId]
    );
    const paymentId = paymentRows[0].id;

    // Outstanding-per-sale, oldest first — if a specific sale was chosen,
    // it's moved to the front of the queue but the rest still follows in
    // date order, so an overpayment on one bill correctly rolls onto the
    // next-oldest rather than being stranded.
    const { rows: outstandingSales } = await client.query(
      `
      WITH credit_sales AS (
        SELECT s.id, s.business_date, COALESCE(SUM(st.amount) FILTER (WHERE st.tender_type = 'credit'), 0) AS credit_amount
        FROM sales s
        JOIN customers cust ON cust.id = s.customer_id
        LEFT JOIN sale_tenders st ON st.sale_id = s.id
        WHERE s.status = 'completed' AND (cust.id = $1 OR cust.account_customer_id = $1)
        GROUP BY s.id
      ),
      allocations AS (SELECT sale_id, SUM(amount_allocated) AS allocated FROM customer_payment_allocations GROUP BY sale_id)
      SELECT cs.id, cs.business_date, (cs.credit_amount - COALESCE(a.allocated, 0))::numeric(14,2) AS outstanding
      FROM credit_sales cs LEFT JOIN allocations a ON a.sale_id = cs.id
      WHERE cs.credit_amount > 0 AND (cs.credit_amount - COALESCE(a.allocated, 0)) > 0.005
      ORDER BY (cs.id = $2) DESC NULLS LAST, cs.business_date ASC
      `,
      [input.customerId, input.allocateToSaleId]
    );

    let remaining = input.amount;
    for (const sale of outstandingSales) {
      if (remaining <= 0.005) break;
      const applied = Math.min(remaining, Number(sale.outstanding));
      await client.query(
        `INSERT INTO customer_payment_allocations (customer_payment_id, sale_id, amount_allocated) VALUES ($1,$2,$3)`,
        [paymentId, sale.id, round2(applied)]
      );
      remaining -= applied;
    }

    await client.query("COMMIT");
    return { id: paymentId, unallocatedAmount: round2(remaining) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getCustomerStatement(customerId: string, fromDate: string, toDate: string) {
  const db = requirePool();
  const { rows: custRows } = await db.query(`SELECT id, name, phone, credit_limit FROM customers WHERE id = $1`, [customerId]);
  if (!custRows[0]) throw new CustomerError("customer_not_found");

  const { rows: bills } = await db.query(
    `
    SELECT s.id, s.bill_number, s.business_date, s.grand_total,
      COALESCE(SUM(st.amount) FILTER (WHERE st.tender_type = 'credit'), 0)::numeric(12,2) AS credit_amount
    FROM sales s
    JOIN customers cust ON cust.id = s.customer_id
    LEFT JOIN sale_tenders st ON st.sale_id = s.id
    WHERE (cust.id = $1 OR cust.account_customer_id = $1) AND s.status = 'completed'
      AND s.business_date BETWEEN $2 AND $3
    GROUP BY s.id
    ORDER BY s.business_date
    `,
    [customerId, fromDate, toDate]
  );
  const { rows: payments } = await db.query(
    `SELECT id, amount, payment_method, reference_number, created_at FROM customer_payments
     WHERE customer_id = $1 AND created_at::date BETWEEN $2 AND $3 ORDER BY created_at`,
    [customerId, fromDate, toDate]
  );
  const balance = await getCustomerBalance(customerId);

  return { customer: custRows[0], bills, payments, currentBalance: balance.balance };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Bulk customer import (owner-requested) — same preview-diff shape
// as the product master's bulk import (repo/product-master.ts) and
// Inventory's bulk tools: nothing is written until Commit, and Preview
// shows exactly what will change per row first.
export interface CustomerDiffRow {
  rowNumber: number;
  ok: boolean;
  error: string | null;
  action: "create" | "update" | null;
  name: string;
  phone: string | null;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
}

const CUSTOMER_IMPORT_BOOL_FIELDS = ["credit_enabled", "whatsapp_transactional_opt_in", "whatsapp_marketing_opt_in"] as const;

async function diffCustomerRows(csvText: string): Promise<CustomerDiffRow[]> {
  const rows = parseCsv(csvText);
  const out: CustomerDiffRow[] = [];
  // Matched by phone, same as findOrCreateCustomer's own walk-in
  // matching — a phone seen twice in one file would otherwise create two
  // separate customers, since each row is diffed independently against
  // the database, not against earlier rows in the same batch.
  const phonesSeen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const name = (r.name ?? "").trim();
    const phone = (r.phone ?? "").trim() || null;
    const base: CustomerDiffRow = { rowNumber: i + 2, ok: false, error: null, action: null, name, phone, changes: [] };

    if (!name) {
      out.push({ ...base, error: "missing_name" });
      continue;
    }
    if (phone && phonesSeen.has(phone)) {
      out.push({ ...base, error: "duplicate_phone_in_file" });
      continue;
    }
    if (phone) phonesSeen.add(phone);

    const existing = phone ? await findCustomerByPhone(phone) : null;

    if (existing) {
      const { rows: fullRows } = await requirePool().query(
        `SELECT name, credit_enabled, credit_limit, payment_terms_days, whatsapp_transactional_opt_in, whatsapp_marketing_opt_in
         FROM customers WHERE id = $1`,
        [existing.id]
      );
      const e = fullRows[0];
      const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
      if (name !== e.name) changes.push({ field: "name", from: e.name, to: name });
      for (const field of CUSTOMER_IMPORT_BOOL_FIELDS) {
        if (r[field] !== undefined && r[field] !== "" && (r[field] === "true") !== e[field]) {
          changes.push({ field, from: e[field], to: r[field] === "true" });
        }
      }
      if (r.credit_limit !== undefined && r.credit_limit !== "" && Number(r.credit_limit) !== Number(e.credit_limit ?? NaN)) {
        changes.push({ field: "credit_limit", from: e.credit_limit, to: Number(r.credit_limit) });
      }
      if (r.payment_terms_days !== undefined && r.payment_terms_days !== "" && Number(r.payment_terms_days) !== e.payment_terms_days) {
        changes.push({ field: "payment_terms_days", from: e.payment_terms_days, to: Number(r.payment_terms_days) });
      }
      out.push({ ...base, ok: true, action: "update", changes });
    } else {
      out.push({
        ...base,
        ok: true,
        action: "create",
        changes: [{ field: "name", from: null, to: name }, { field: "phone", from: null, to: phone }],
      });
    }
  }
  return out;
}

export async function diffCustomerBulkImport(csvText: string): Promise<CustomerDiffRow[]> {
  return diffCustomerRows(csvText);
}

export async function commitCustomerBulkImport(csvText: string): Promise<{ created: number; updated: number; skipped: number }> {
  const rows = parseCsv(csvText);
  const diff = await diffCustomerRows(csvText);
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < diff.length; i++) {
    const d = diff[i]!;
    if (!d.ok) { skipped++; continue; }
    const raw = rows[i]!;

    if (d.action === "update") {
      if (d.changes.length === 0) { skipped++; continue; }
      const existing = await findCustomerByPhone(d.phone!);
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, val: unknown) => { values.push(val); sets.push(`${col} = $${values.length}`); };
      if (d.changes.some((c) => c.field === "name")) set("name", d.name);
      for (const field of CUSTOMER_IMPORT_BOOL_FIELDS) {
        if (raw[field] !== undefined && raw[field] !== "") set(field, raw[field] === "true");
      }
      if (raw.credit_limit !== undefined && raw.credit_limit !== "") set("credit_limit", Number(raw.credit_limit));
      if (raw.payment_terms_days !== undefined && raw.payment_terms_days !== "") set("payment_terms_days", Number(raw.payment_terms_days));
      if (sets.length > 0) {
        values.push(existing!.id);
        await requirePool().query(`UPDATE customers SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
      }
      updated++;
    } else if (d.action === "create") {
      await requirePool().query(
        `INSERT INTO customers (name, phone, credit_enabled, credit_limit, payment_terms_days, whatsapp_transactional_opt_in, whatsapp_marketing_opt_in)
         VALUES ($1,$2,$3,$4,$5,
           COALESCE($6, true),
           COALESCE($7, false))`,
        [
          d.name,
          d.phone,
          raw.credit_enabled === "true",
          raw.credit_limit ? Number(raw.credit_limit) : null,
          raw.payment_terms_days ? Number(raw.payment_terms_days) : 0,
          raw.whatsapp_transactional_opt_in === "" || raw.whatsapp_transactional_opt_in === undefined ? null : raw.whatsapp_transactional_opt_in === "true",
          raw.whatsapp_marketing_opt_in === "" || raw.whatsapp_marketing_opt_in === undefined ? null : raw.whatsapp_marketing_opt_in === "true",
        ]
      );
      created++;
    }
  }
  return { created, updated, skipped };
}
