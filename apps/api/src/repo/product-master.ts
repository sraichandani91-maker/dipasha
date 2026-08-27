import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { parseCsv } from "../lib/csv.js";
import { findOrCreateSalt } from "./salts.js";
import { substituteGroupKey } from "../domain/substitute-group.js";
import { createProduct, updateProduct } from "./products.js";
import { generateInternalBarcode } from "../domain/barcode.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export class ProductMasterError extends Error {
  constructor(public code: string, public details: unknown = null) {
    super(code);
  }
}

// --- Substitute group management -----------------------------------
// Section 10.2: "Manage substitute_group_id mappings — much easier on a
// big screen; this is where you will do most of your generic-
// substitution setup." The M2 value is auto-computed from composition +
// form and has no override today — this is that override, a straight
// UPDATE on the one join key every consumer (search, order-picking
// substitute lookup, request-book substitute finding) already reads.

export interface SubstituteGroup {
  groupId: string;
  products: Array<{ id: string; name: string; manufacturer: string; form: string }>;
}

export async function listSubstituteGroups(): Promise<SubstituteGroup[]> {
  const { rows } = await requirePool().query(`
    SELECT substitute_group_id, id, name, manufacturer, form
    FROM products
    WHERE substitute_group_id IS NOT NULL AND status = 'active'
    ORDER BY substitute_group_id, name
  `);
  const byGroup = new Map<string, SubstituteGroup>();
  for (const r of rows) {
    if (!byGroup.has(r.substitute_group_id)) byGroup.set(r.substitute_group_id, { groupId: r.substitute_group_id, products: [] });
    byGroup.get(r.substitute_group_id)!.products.push({ id: r.id, name: r.name, manufacturer: r.manufacturer, form: r.form });
  }
  return [...byGroup.values()].sort((a, b) => b.products.length - a.products.length);
}

// targetProductId: adopt that product's current group. null: split into
// a brand-new group of its own (a fresh uuid — never NULL, so it never
// silently falls back to being ungrouped and invisible to substitute
// lookups elsewhere).
export async function moveProductToGroup(productId: string, targetProductId: string | null, note: string, actorUserId: string): Promise<{ newGroupId: string }> {
  const db = requirePool();
  const { rows: prodRows } = await db.query(`SELECT substitute_group_id FROM products WHERE id = $1`, [productId]);
  if (!prodRows[0]) throw new ProductMasterError("product_not_found");
  const oldGroupId: string | null = prodRows[0].substitute_group_id;

  let newGroupId: string;
  if (targetProductId) {
    const { rows: targetRows } = await db.query(`SELECT substitute_group_id FROM products WHERE id = $1`, [targetProductId]);
    if (!targetRows[0]) throw new ProductMasterError("target_product_not_found");
    newGroupId = targetRows[0].substitute_group_id ?? randomUUID();
    if (!targetRows[0].substitute_group_id) {
      await db.query(`UPDATE products SET substitute_group_id = $1 WHERE id = $2`, [newGroupId, targetProductId]);
    }
  } else {
    newGroupId = randomUUID();
  }

  await db.query(`UPDATE products SET substitute_group_id = $1 WHERE id = $2`, [newGroupId, productId]);
  await db.query(
    `INSERT INTO product_group_changes (product_id, old_group_id, new_group_id, note, actor_user_id) VALUES ($1,$2,$3,$4,$5)`,
    [productId, oldGroupId, newGroupId, note, actorUserId]
  );
  return { newGroupId };
}

// --- Bulk CSV import of the product master --------------------------
// Section 10.2: "Bulk CSV import of the product master with preview
// diff." Rows are matched by (name, manufacturer) — an unmatched row is
// a create, a matched row is an update. Composition is only used on
// create (createProduct requires at least one) — this build has no
// bulk-recompose path for an existing product's salts, since that would
// also change its auto-computed substitute group in a way a spreadsheet
// row can't safely reason about; use the substitute-group screen for
// that instead. An existing row's update is deliberately limited to the
// same fields the single-product edit screen already allows (barcode,
// allow_loose_sale, status) — not form/schedule/HSN/GST/pack size, which
// touch statutory and historical-sale data this milestone isn't
// re-litigating.

interface ProductDiffRow {
  rowNumber: number;
  ok: boolean;
  error: string | null;
  action: "create" | "update" | null;
  name: string;
  manufacturer: string;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
}

function parseComposition(cell: string): Array<{ saltName: string; strength: string }> | null {
  if (!cell) return null;
  const parts = cell.split("|").map((p) => p.trim()).filter(Boolean);
  const out: Array<{ saltName: string; strength: string }> = [];
  for (const p of parts) {
    const [saltName, strength] = p.split(":").map((s) => s?.trim());
    if (!saltName || !strength) return null;
    out.push({ saltName, strength });
  }
  return out.length > 0 ? out : null;
}

async function diffRows(csvText: string): Promise<ProductDiffRow[]> {
  const rows = parseCsv(csvText);
  const out: ProductDiffRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const name = r.name ?? "";
    const manufacturer = r.manufacturer ?? "";
    const base: ProductDiffRow = { rowNumber: i + 2, ok: false, error: null, action: null, name, manufacturer, changes: [] };
    if (!name || !manufacturer) {
      out.push({ ...base, error: "invalid_row" });
      continue;
    }

    const { rows: existingRows } = await requirePool().query(
      `SELECT id, barcode, allow_loose_sale, status FROM products WHERE lower(name) = lower($1) AND lower(manufacturer) = lower($2)`,
      [name, manufacturer]
    );
    const existing = existingRows[0];

    if (existing) {
      const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
      if (r.barcode && r.barcode !== (existing.barcode ?? "")) changes.push({ field: "barcode", from: existing.barcode, to: r.barcode });
      if (r.allow_loose_sale && (r.allow_loose_sale === "true") !== existing.allow_loose_sale) changes.push({ field: "allow_loose_sale", from: existing.allow_loose_sale, to: r.allow_loose_sale === "true" });
      if (r.status && r.status !== existing.status) changes.push({ field: "status", from: existing.status, to: r.status });
      out.push({ ...base, ok: true, action: "update", changes });
    } else {
      const form = r.form ?? "";
      const scheduleCategory = r.schedule_category ?? "";
      const hsnCode = r.hsn_code ?? "";
      const gstRate = Number(r.gst_rate);
      const baseUnit = r.base_unit ?? "";
      const packSize = Number(r.pack_size);
      const compositions = parseComposition(r.composition ?? "");
      if (!form || !scheduleCategory || !hsnCode || !Number.isFinite(gstRate) || !baseUnit || !Number.isFinite(packSize) || packSize <= 0 || !compositions) {
        out.push({ ...base, error: "missing_required_fields_for_create" });
        continue;
      }
      out.push({
        ...base,
        ok: true,
        action: "create",
        changes: [
          { field: "form", from: null, to: form },
          { field: "schedule_category", from: null, to: scheduleCategory },
          { field: "composition", from: null, to: r.composition },
        ],
      });
    }
  }
  return out;
}

export async function diffBulkProductImport(csvText: string): Promise<ProductDiffRow[]> {
  return diffRows(csvText);
}

export async function commitBulkProductImport(csvText: string, actorUserId: string): Promise<{ created: number; updated: number; skipped: number }> {
  const rows = parseCsv(csvText);
  const diff = await diffRows(csvText);
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < diff.length; i++) {
    const d = diff[i]!;
    if (!d.ok) { skipped++; continue; }
    const raw = rows[i]!;

    if (d.action === "update") {
      if (d.changes.length === 0) { skipped++; continue; }
      const { rows: existingRows } = await requirePool().query(
        `SELECT id FROM products WHERE lower(name) = lower($1) AND lower(manufacturer) = lower($2)`,
        [d.name, d.manufacturer]
      );
      await updateProduct(existingRows[0].id, {
        barcode: raw.barcode || undefined,
        allowLooseSale: raw.allow_loose_sale ? raw.allow_loose_sale === "true" : undefined,
        status: (raw.status as any) || undefined,
      });
      updated++;
    } else if (d.action === "create") {
      const compositions = parseComposition(raw.composition ?? "")!;
      const resolved = [];
      for (const c of compositions) {
        const salt = await findOrCreateSalt(c.saltName);
        resolved.push({ saltId: salt.id, strength: c.strength });
      }
      const substituteGroupId = substituteGroupKey(resolved, raw.form ?? "");
      await createProduct({
        name: raw.name ?? "",
        manufacturer: raw.manufacturer ?? "",
        form: raw.form ?? "",
        scheduleCategory: (raw.schedule_category ?? "") as any,
        requiresPrescription: raw.schedule_category === "H" || raw.schedule_category === "H1",
        hsnCode: raw.hsn_code ?? "",
        gstRate: Number(raw.gst_rate),
        baseUnit: raw.base_unit ?? "",
        packSize: Number(raw.pack_size),
        outerPackSize: null,
        allowLooseSale: raw.allow_loose_sale === "true",
        looseSaleMarkupPercent: 0,
        isColdChain: raw.is_cold_chain === "true",
        barcode: raw.barcode || generateInternalBarcode(),
        compositions: resolved,
        substituteGroupId,
        status: "active",
        createdBy: actorUserId,
      });
      created++;
    }
  }
  return { created, updated, skipped };
}
