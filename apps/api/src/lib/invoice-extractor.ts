import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's structured-output helper is built against zod/v4's ZodType,
// not classic zod v3 (what the rest of this codebase's route validation
// uses) — zod 3.25+ ships both APIs from the same package, so this
// import is scoped to this one file rather than migrating every route.
import { z } from "zod/v4";

/**
 * Section 6.3, Stage 2 — "send to a vision-capable LLM with a structured
 * output schema (JSON), not free-text parsing." Uses Claude's structured
 * outputs (`messages.parse` + a Zod schema), not a forced tool call —
 * the SDK-recommended approach for "give me exactly this JSON shape."
 *
 * PDFs go in as a native `document` content block (Claude reads
 * multi-page PDFs directly, up to 600 pages — no per-page split needed);
 * a multi-photo capture goes in as one `image` block per page, in order.
 */

const ExtractedLineSchema = z.object({
  productNameAsPrinted: z.string(),
  batchNumber: z.string().nullable(),
  expiryRaw: z.string().nullable(),
  expiryNormalized: z
    .string()
    .nullable()
    .describe("ISO date YYYY-MM-DD, normalized from whatever format was printed (MM/YY, MM-YYYY, MMM YY, etc.) — use the last day of that month"),
  quantityBaseUnits: z.number().describe("Quantity in the smallest printed unit (e.g. tablets, not strips) — convert pack quantities using the pack size printed on the line if shown"),
  freeQuantityBaseUnits: z.number().describe("Free/bonus quantity, 0 if none printed"),
  rateBeforeDiscount: z.number().describe("Rate per base unit before any line discount"),
  discountPercent: z.number().nullable(),
  discountValue: z.number().nullable(),
  gstRate: z.number().nullable().describe("GST percentage for this line, e.g. 12 for 12%"),
  mrp: z.number().nullable(),
  lineTotal: z.number().nullable(),
  confidence: z.number().min(0).max(1).describe("Overall confidence (0-1) that this line was read correctly"),
});

const ExtractedInvoiceSchema = z.object({
  vendorNameExtracted: z.string(),
  gstinExtracted: z.string().nullable(),
  invoiceNumberExtracted: z.string(),
  invoiceDateExtracted: z.string().nullable().describe("ISO date YYYY-MM-DD"),
  invoiceTotalExtracted: z.number().nullable(),
  taxableValueExtracted: z.number().nullable(),
  cgstExtracted: z.number().nullable(),
  sgstExtracted: z.number().nullable(),
  igstExtracted: z.number().nullable(),
  headerConfidence: z.object({
    vendorName: z.number().min(0).max(1),
    gstin: z.number().min(0).max(1),
    invoiceNumber: z.number().min(0).max(1),
    invoiceDate: z.number().min(0).max(1),
    invoiceTotal: z.number().min(0).max(1),
  }),
  lines: z.array(ExtractedLineSchema),
});

export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;
export type ExtractedLine = z.infer<typeof ExtractedLineSchema>;

const SYSTEM_PROMPT = `You extract structured data from Indian pharmaceutical distributor GST purchase invoices. Read every line item — invoices routinely run several pages. Report your genuine confidence per field; do not default every field to a high score. Normalize expiry dates to ISO YYYY-MM-DD using the last day of the printed month. If a field is not printed or illegible, use null rather than guessing.`;

export interface ScanPageInput {
  data: Buffer;
  mimeType: string;
}

export class ExtractionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function extractInvoice(pages: ScanPageInput[], model: string): Promise<ExtractedInvoice> {
  const content: Anthropic.MessageParam["content"] = [];
  for (const page of pages) {
    const data = page.data.toString("base64");
    if (page.mimeType === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
    } else {
      content.push({ type: "image", source: { type: "base64", media_type: page.mimeType as "image/jpeg" | "image/png" | "image/webp", data } });
    }
  }
  content.push({ type: "text", text: "Extract this purchase invoice." });

  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      output_config: { effort: "high", format: zodOutputFormat(ExtractedInvoiceSchema) },
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new ExtractionError("invalid_api_key", err.message);
    if (err instanceof Anthropic.RateLimitError) throw new ExtractionError("rate_limited", err.message);
    if (err instanceof Anthropic.BadRequestError) throw new ExtractionError("bad_request", err.message);
    if (err instanceof Anthropic.APIError) throw new ExtractionError("provider_error", err.message);
    throw err;
  }

  if (!response.parsed_output) throw new ExtractionError("no_structured_output", "Model did not return a structured extraction");
  return response.parsed_output;
}
