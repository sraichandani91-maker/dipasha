/**
 * M1 seed data: 4 role users, ~20 salts, 50 dummy SKUs (2 brands per
 * molecule, so every one lands in a real substitute group for testing),
 * ~59 bins across regular aisles and every special zone prefix, batches,
 * and opening-stock movements putting real stock on hand.
 *
 * Opening stock has no purchase history, so every seeded batch is marked
 * cost_unknown per Section 6.5's own stated example of when to do that —
 * this isn't a seed-script shortcut, it's the documented correct case.
 *
 * Run once against a fresh dev database: npm run seed --workspace apps/api
 */
import "dotenv/config";
import { pool } from "../src/db.js";
import { hashSecret } from "../src/auth/hash.js";
import { substituteGroupKey } from "../src/domain/substitute-group.js";

if (!pool) {
  console.error("DATABASE_URL is not set — nothing to seed against.");
  process.exit(1);
}
const db = pool;

const MANUFACTURERS = [
  "Sun Pharma", "Cipla", "Cadila Healthcare", "Mankind Pharma", "Alkem Labs",
  "Zydus Lifesciences", "Torrent Pharma", "Intas Pharma", "Dr. Reddy's", "Lupin",
  "Micro Labs", "GSK", "Abbott India", "USV Pvt Ltd", "Glenmark",
];
let mfgIdx = 0;
function nextManufacturer(): string {
  const m = MANUFACTURERS[mfgIdx % MANUFACTURERS.length];
  mfgIdx += 1;
  return m;
}

interface MoleculeSpec {
  salt: string;
  synonyms?: string[];
  strength: string;
  form: string;
  schedule: "OTC" | "H" | "H1";
  gstRate: number;
  hsnCode: string;
  baseUnit: string;
  packSize: number;
  allowLooseSale: boolean;
  coldChain?: boolean;
  brandPrefixes: [string, string];
  mrp: number; // per pack, for the seeded batch
}

const MOLECULES: MoleculeSpec[] = [
  { salt: "Paracetamol", synonyms: ["PCM", "Paracetamol IP"], strength: "650mg", form: "tablet", schedule: "OTC", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Dolo", "Calpol"], mrp: 30 },
  { salt: "Amoxicillin", strength: "500mg", form: "capsule", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "capsule", packSize: 10, allowLooseSale: true, brandPrefixes: ["Novamox", "Mox"], mrp: 85 },
  { salt: "Amoxicillin Clavulanic Acid", synonyms: ["Amoxyclav"], strength: "625mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Augmentin", "Clavam"], mrp: 210 },
  { salt: "Azithromycin", strength: "500mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 3, allowLooseSale: true, brandPrefixes: ["Azithral", "Azee"], mrp: 110 },
  { salt: "Cetirizine", strength: "10mg", form: "tablet", schedule: "OTC", gstRate: 5, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Cetrizet", "Alerid"], mrp: 20 },
  { salt: "Levocetirizine", strength: "5mg", form: "tablet", schedule: "OTC", gstRate: 5, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Levocet", "Xyzal"], mrp: 35 },
  { salt: "Metformin", strength: "500mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Glycomet", "Glyciphage"], mrp: 45 },
  { salt: "Amlodipine", strength: "5mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Amlong", "Amlopres"], mrp: 40 },
  { salt: "Atorvastatin", strength: "10mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Atorva", "Storvas"], mrp: 90 },
  { salt: "Pantoprazole", strength: "40mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Pantocid", "Pan-D"], mrp: 95 },
  { salt: "Omeprazole", strength: "20mg", form: "capsule", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "capsule", packSize: 10, allowLooseSale: true, brandPrefixes: ["Omez", "Ocid"], mrp: 60 },
  { salt: "Ibuprofen", strength: "400mg", form: "tablet", schedule: "OTC", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Brufen", "Ibugesic"], mrp: 35 },
  { salt: "Diclofenac", strength: "50mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Voveran", "Dicloran"], mrp: 30 },
  { salt: "Oral Rehydration Salts", synonyms: ["ORS"], strength: "21.8g", form: "sachet", schedule: "OTC", gstRate: 5, hsnCode: "3004", baseUnit: "sachet", packSize: 1, allowLooseSale: false, brandPrefixes: ["Electral", "ORSL"], mrp: 20 },
  { salt: "Vitamin C", strength: "500mg", form: "tablet", schedule: "OTC", gstRate: 5, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Limcee", "Celin"], mrp: 25 },
  { salt: "Vitamin D3", strength: "60000IU", form: "capsule", schedule: "OTC", gstRate: 5, hsnCode: "3004", baseUnit: "capsule", packSize: 4, allowLooseSale: true, brandPrefixes: ["Calcirol", "Uprise-D3"], mrp: 90 },
  { salt: "Calcium Carbonate Vitamin D3", synonyms: ["Cal + D3"], strength: "500mg", form: "tablet", schedule: "OTC", gstRate: 5, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Shelcal", "Calcimax"], mrp: 110 },
  { salt: "Losartan", strength: "50mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Losar", "Repace"], mrp: 60 },
  { salt: "Telmisartan", strength: "40mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 15, allowLooseSale: true, brandPrefixes: ["Telma", "Telsartan"], mrp: 95 },
  { salt: "Domperidone", strength: "10mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Domstal", "Vomistop"], mrp: 28 },
  { salt: "Ondansetron", strength: "4mg", form: "tablet", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Emeset", "Ondem"], mrp: 45 },
  { salt: "Insulin Glargine", strength: "100IU/ml", form: "injection", schedule: "H", gstRate: 5, hsnCode: "3004", baseUnit: "ml", packSize: 3, allowLooseSale: false, coldChain: true, brandPrefixes: ["Lantus", "Basalog"], mrp: 950 },
  { salt: "Salbutamol", strength: "100mcg", form: "inhaler", schedule: "H", gstRate: 12, hsnCode: "3004", baseUnit: "inhaler", packSize: 1, allowLooseSale: false, brandPrefixes: ["Asthalin", "Levolin"], mrp: 130 },
  { salt: "Povidone Iodine", strength: "5% w/v", form: "topical solution", schedule: "OTC", gstRate: 12, hsnCode: "3004", baseUnit: "ml", packSize: 100, allowLooseSale: false, brandPrefixes: ["Betadine", "Cipladine"], mrp: 65 },
  { salt: "Alprazolam", strength: "0.25mg", form: "tablet", schedule: "H1", gstRate: 12, hsnCode: "3004", baseUnit: "tablet", packSize: 10, allowLooseSale: true, brandPrefixes: ["Alprax", "Restyl"], mrp: 22 },
];

function toDateOffset(monthsFromNow: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + monthsFromNow);
  return d.toISOString().slice(0, 10);
}

function internalBarcode(seq: number): string {
  // Not a real EAN — a clearly-internal placeholder for SKUs with no
  // scannable manufacturer barcode (Section 9A.5). "290" prefix is in the
  // GS1 restricted-circulation-number range, safe for internal use.
  const body = String(2900000000000 + seq);
  return body.slice(0, 13);
}

async function main() {
  console.log("== Seeding Dipasha dev data ==");

  const existing = await db.query(`SELECT count(*) FROM products`);
  if (Number(existing.rows[0].count) > 0) {
    console.error("products table is not empty — refusing to double-seed. Truncate first if you want to reseed.");
    process.exit(1);
  }

  // -- Users --
  // Username + password login (owner-requested — replaced phone + OTP to
  // avoid needing a paid SMS/WhatsApp provider). `phone` is kept on each
  // seeded account since it's still the target for outbound WhatsApp
  // notifications (the owner's daily digest, refill reminders, etc.) —
  // it just isn't how anyone logs in anymore.
  const pin = "1234";
  const password = "dipasha123";
  const [pinHash, passwordHash] = await Promise.all([hashSecret(pin), hashSecret(password)]);
  const userSpecs: Array<{ username: string; phone: string; name: string; role: string }> = [
    { username: "owner", phone: "+919999900001", name: "Owner (seed)", role: "owner" },
    { username: "manager", phone: "+919999900002", name: "Store Manager (seed)", role: "store_manager" },
    { username: "picker", phone: "+919999900003", name: "Picker Packer (seed)", role: "picker_packer" },
    { username: "rider", phone: "+919999900004", name: "Rider (seed)", role: "rider" },
  ];
  const userIds: Record<string, string> = {};
  for (const u of userSpecs) {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, phone, name, role, pin_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [u.username, passwordHash, u.phone, u.name, u.role, pinHash]
    );
    userIds[u.role] = rows[0].id;
  }
  const ownerId = userIds.owner;
  console.log(`Seeded ${userSpecs.length} users (password for all: ${password}, PIN: ${pin})`);

  // -- Bins --
  const binIds: { regular: string[]; cc: string[]; sh: string[]; other: Record<string, string[]> } = {
    regular: [], cc: [], sh: [], other: {},
  };
  async function insertBin(code: string, zone: string | null, extra: Partial<{ aisle: string; bay: string; shelfLevel: string; position: number; restricted: boolean; pickFrequencyRank: number }> = {}) {
    const { rows } = await db.query(
      `INSERT INTO bins (code, zone, aisle, bay, shelf_level, position, restricted, pick_frequency_rank, capacity_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [code, zone, extra.aisle ?? null, extra.bay ?? null, extra.shelfLevel ?? null, extra.position ?? null, extra.restricted ?? false, extra.pickFrequencyRank ?? null, 100]
    );
    return rows[0].id as string;
  }

  for (const aisle of ["A", "B"]) {
    for (let bay = 1; bay <= 4; bay++) {
      for (const shelf of ["A", "B", "C"]) {
        for (let pos = 1; pos <= 2; pos++) {
          const code = `${aisle}-${String(bay).padStart(2, "0")}-${shelf}-${pos}`;
          const id = await insertBin(code, null, { aisle, bay: String(bay), shelfLevel: shelf, position: pos, pickFrequencyRank: shelf === "B" || shelf === "C" ? 1 : 3 });
          binIds.regular.push(id);
        }
      }
    }
  }
  for (const code of ["CC-01", "CC-02"]) binIds.cc.push(await insertBin(code, "CC", { restricted: false }));
  for (const code of ["SH-01", "SH-02"]) binIds.sh.push(await insertBin(code, "SH", { restricted: true }));
  binIds.other.RX = [await insertBin("RX-01", "RX")];
  binIds.other.IN = [await insertBin("IN-01", "IN")];
  binIds.other.QC = [await insertBin("QC-01", "QC")];
  binIds.other.PK = [await insertBin("PK-01", "PK")];
  binIds.other.FM = [await insertBin("FM-01", "FM"), await insertBin("FM-02", "FM"), await insertBin("FM-03", "FM")];
  const totalBins = binIds.regular.length + binIds.cc.length + binIds.sh.length + Object.values(binIds.other).flat().length;
  console.log(`Seeded ${totalBins} bins`);

  // -- Salts --
  const saltIds = new Map<string, string>();
  for (const m of MOLECULES) {
    if (saltIds.has(m.salt)) continue;
    const { rows } = await db.query(`INSERT INTO salts (name) VALUES ($1) RETURNING id`, [m.salt]);
    saltIds.set(m.salt, rows[0].id);
    for (const syn of m.synonyms ?? []) {
      await db.query(`INSERT INTO salt_synonyms (salt_id, synonym) VALUES ($1, $2)`, [rows[0].id, syn]);
    }
  }
  console.log(`Seeded ${saltIds.size} salts`);

  // -- Products, compositions, batches, opening stock --
  let regularBinCursor = 0;
  let productCount = 0;
  let batchCount = 0;
  let barcodeSeq = 1;

  for (const m of MOLECULES) {
    const saltId = saltIds.get(m.salt)!;
    for (const brandPrefix of m.brandPrefixes) {
      const manufacturer = nextManufacturer();
      const productName = `${brandPrefix} ${m.strength.replace(/[^0-9.]/g, "")}`.trim();
      const requiresPrescription = m.schedule === "H" || m.schedule === "H1";
      const substituteGroupId = substituteGroupKey([{ saltId, strength: m.strength }], m.form);

      const { rows: productRows } = await db.query(
        `INSERT INTO products
           (name, manufacturer, form, schedule_category, requires_prescription, hsn_code, gst_rate,
            base_unit, pack_size, allow_loose_sale, is_cold_chain, barcode, substitute_group_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          productName, manufacturer, m.form, m.schedule, requiresPrescription, m.hsnCode, m.gstRate,
          m.baseUnit, m.packSize, m.allowLooseSale, m.coldChain ?? false, internalBarcode(barcodeSeq++),
          substituteGroupId, ownerId,
        ]
      );
      const productId = productRows[0].id;
      productCount++;

      await db.query(
        `INSERT INTO product_compositions (product_id, salt_id, strength, position) VALUES ($1, $2, $3, 0)`,
        [productId, saltId, m.strength]
      );

      // Batch + opening stock. No purchase history exists for this batch
      // (it's seed data, not a real GRN) — Section 6.5 is explicit that
      // this exact situation gets marked cost_unknown, not a fabricated
      // cost or a zero.
      const binId = m.coldChain
        ? binIds.cc[batchCount % binIds.cc.length]
        : m.schedule === "H1"
          ? binIds.sh[batchCount % binIds.sh.length]
          : binIds.regular[regularBinCursor++ % binIds.regular.length];

      const batchNo = `SEED-${String(batchCount + 1).padStart(3, "0")}`;
      const expiryDate = toDateOffset(6 + (batchCount % 18)); // spread 6-24 months out
      const { rows: batchRows } = await db.query(
        `INSERT INTO batches (product_id, batch_no, expiry_date, mrp, cost_unknown, free_quantity_base_units)
         VALUES ($1, $2, $3, $4, true, 0) RETURNING id`,
        [productId, batchNo, expiryDate, m.mrp]
      );
      const batchId = batchRows[0].id;
      batchCount++;

      const packsOnHand = 3 + (batchCount % 4); // 3-6 packs
      const qtyBaseUnits = packsOnHand * m.packSize;
      await db.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, source, actor_user_id, device_id)
         VALUES ('stock_received', $1, $2, $3, $4, 'opening_stock', 'M1 seed data — no purchase history', 'app', $5, 'seed-script')`,
        [productId, batchId, binId, qtyBaseUnits, ownerId]
      );
    }
  }

  console.log(`Seeded ${productCount} products across ${saltIds.size} salts`);
  console.log(`Seeded ${batchCount} batches with opening-stock movements`);
  console.log("\n== Dev login credentials (this environment only) ==");
  for (const u of userSpecs) {
    console.log(`  ${u.role.padEnd(14)} username: ${u.username.padEnd(10)} password: ${password}`);
  }
}

main()
  .then(() => db.end())
  .catch(async (err) => {
    console.error(err);
    await db.end();
    process.exit(1);
  });
