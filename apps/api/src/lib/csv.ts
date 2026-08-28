/**
 * Section 10A: every statutory report is downloadable as CSV at minimum
 * (Excel-openable as-is; a real multi-sheet .xlsx with styling is a
 * reasonable follow-up, not built here — see DECISIONS.md). No external
 * dependency — CSV is simple enough to be worth not pulling one in for.
 */
// Shared by every CSV-downloadable report/export in the build (statutory
// reports, M15's ledgers) — one place setting the attachment header
// consistently rather than each route re-typing it.
export function sendCsvAttachment(reply: { header: (n: string, v: string) => any; type: (t: string) => any; send: (b: string) => any }, filenameStem: string, rows: Array<Record<string, unknown>>) {
  reply.header("Content-Disposition", `attachment; filename="${filenameStem}.csv"`).type("text/csv").send(toCsv(rows));
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return columns ? columns.join(",") + "\n" : "";
  const cols = columns ?? Object.keys(rows[0]!);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => escape(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

// Section 10.2's bulk CSV import (stock adjustment, bin reassignment,
// price update) — comma-split, header row required, no quoted-field or
// embedded-comma support. Deliberately simple (Section 12: "optimise for
// one person maintaining it") — product/batch/bin identifiers in this
// build don't contain commas, so this is a real limitation, not a
// silently-accepted one.
export function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0]!.split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}
