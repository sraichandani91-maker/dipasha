import { pool } from "../db.js";
import { allocateFefo, getSpecificBatchStock, InsufficientStockError } from "../domain/fefo.js";

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  return pool;
}

export type StockIssueReasonCode = "sample_given" | "doctor_sample" | "staff_use" | "promotional" | "transfer_out" | "replacement_given" | "other";

export interface CreateStockIssueInput {
  productId: string;
  quantityBaseUnits: number;
  reasonCode: StockIssueReasonCode;
  note: string;
  recipientName: string | null;
  manualBatchId: string | null;
  manualBatchOverrideReason: string | null;
  createdBy: string;
  deviceId: string;
  source: "app" | "web" | "web_manual";
}

export class InsufficientStockForIssueError extends Error {
  constructor(public available: number, public requested: number) {
    super("insufficient stock");
  }
}

// Section 6.5 (non-GST outbound): batch is FEFO-selected by default,
// override permitted and logged. No item category is blocked — Schedule
// H/H1/X can be issued like anything else (Section 6.5's own text is
// explicit on this), the reason code and note are what makes it
// auditable, same as any non-GST movement.
export async function createStockIssue(input: CreateStockIssueInput) {
  const db = requirePool();

  let allocations: Array<{ batchId: string; binId: string; quantity: number }>;
  if (input.manualBatchId) {
    const specific = await getSpecificBatchStock(input.productId, input.manualBatchId);
    if (!specific || specific.available < input.quantityBaseUnits) {
      throw new InsufficientStockForIssueError(specific?.available ?? 0, input.quantityBaseUnits);
    }
    allocations = [{ batchId: input.manualBatchId, binId: specific.binId, quantity: input.quantityBaseUnits }];
  } else {
    try {
      allocations = await allocateFefo(input.productId, input.quantityBaseUnits);
    } catch (err) {
      if (err instanceof InsufficientStockError) throw new InsufficientStockForIssueError(err.available, err.requested);
      throw err;
    }
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const movementIds: string[] = [];
    for (const alloc of allocations) {
      const note = [input.note, input.recipientName ? `Recipient: ${input.recipientName}` : null].filter(Boolean).join(" — ");
      const { rows } = await client.query(
        `INSERT INTO movement_ledger
           (movement_type, product_id, batch_id, bin_id, quantity_delta, reason_code, note, source, actor_user_id, device_id)
         VALUES ('stock_issue', $1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [input.productId, alloc.batchId, alloc.binId, -alloc.quantity, input.reasonCode, note, input.source, input.createdBy, input.deviceId]
      );
      movementIds.push(rows[0].id);
    }
    await client.query("COMMIT");
    return { movementIds };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
