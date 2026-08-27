import { useState } from "react";

const REASON_CODES = [
  { value: "scanner_unavailable", label: "Scanner unavailable" },
  { value: "remote_correction", label: "Remote correction" },
  { value: "device_failure", label: "Device failure" },
  { value: "training", label: "Training" },
] as const;

export type WebManualReasonCode = (typeof REASON_CODES)[number]["value"];

/**
 * Section 10.1: every scan-backed action done from web (no scanner)
 * needs a mandatory reason code + free-text note. One small shared
 * fieldset so this looks and behaves the same everywhere it's asked for
 * — put-away, pick, pack, rider handover, cycle count entry.
 */
export function useWebManualOverride() {
  const [reasonCode, setReasonCode] = useState<WebManualReasonCode | "">("");
  const [note, setNote] = useState("");
  const valid = reasonCode !== "" && note.trim().length > 0;
  return { reasonCode, setReasonCode, note, setNote, valid };
}

export function WebManualOverrideFields({
  reasonCode,
  setReasonCode,
  note,
  setNote,
}: {
  reasonCode: WebManualReasonCode | "";
  setReasonCode: (v: WebManualReasonCode | "") => void;
  note: string;
  setNote: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as WebManualReasonCode)} style={{ width: 170 }}>
        <option value="">Reason for manual entry…</option>
        {REASON_CODES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <input placeholder="Note (required)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 180 }} />
    </div>
  );
}
