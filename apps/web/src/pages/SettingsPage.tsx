import { useEffect, useState } from "react";
import { api, ApiError } from "../api.js";

interface Setting {
  key: string;
  value: unknown;
  description: string;
  updatedAt: string;
  updatedByName: string | null;
}

// Purely a display grouping (there's no category column on the settings
// table) — a prefix match against the key, first one to match wins.
const GROUPS: Array<{ label: string; prefixes: string[] }> = [
  { label: "Sales & billing", prefixes: ["bill_number", "credit_note", "separate_bill_series", "offline_bill_number", "sale_return", "below_cost", "eway_bill", "shop_gst_state_code"] },
  { label: "Purchases & GST", prefixes: ["invoice_reconciliation", "expiry_reject", "near_expiry", "po_number", "ai_invoice"] },
  { label: "Cycle counts & cold chain", prefixes: ["cycle_count", "cold_chain"] },
  { label: "Delivery orders", prefixes: ["order_number", "order_batch", "order_response", "pending_order_response", "delivery_batch"] },
  { label: "Order book (Shortbook)", prefixes: ["shortbook", "reorder"] },
  { label: "Requests & callbacks", prefixes: ["daily_request_review", "stock_reservation"] },
  { label: "WhatsApp notifications", prefixes: ["whatsapp"] },
  { label: "Sessions & search", prefixes: ["session_idle", "web_session_idle", "search_sort"] },
  { label: "Write-offs", prefixes: ["writeoff"] },
  { label: "Accounting & PO tracking", prefixes: ["po_chase_window", "financial_daily_digest"] },
];

function groupFor(key: string): string {
  for (const g of GROUPS) {
    if (g.prefixes.some((p) => key.startsWith(p))) return g.label;
  }
  return "Other";
}

/**
 * Section 10.2 "Settings screen — centralize every configurable
 * threshold." Every value here already exists in the settings table
 * (Section 15: "every configurable number goes in settings, not
 * hardcoded"), seeded across every prior milestone's migration — this
 * screen is read/write parity for that table, not a new mechanism.
 */
export default function SettingsPage() {
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setSettings(await api.get("/settings"));
  }
  useEffect(() => { load(); }, []);

  if (!settings) return <div>Loading…</div>;

  const grouped = new Map<string, Setting[]>();
  for (const s of settings) {
    const g = groupFor(s.key);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(s);
  }
  const orderedGroups = [...GROUPS.map((g) => g.label), "Other"].filter((g) => grouped.has(g));

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Settings</h2>
      <p className="hint-text">
        Every configurable threshold in the app, in one place (Section 10.2/15). Changes take effect immediately —
        there's no separate "publish" step.
      </p>
      {error && <p className="error-text">{error}</p>}

      {orderedGroups.map((group) => (
        <div key={group} className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{group}</h3>
          {grouped.get(group)!.map((s) => (
            <SettingRow key={s.key} setting={s} onSaved={load} onError={setError} />
          ))}
        </div>
      ))}
    </div>
  );
}

function SettingRow({ setting, onSaved, onError }: { setting: Setting; onSaved: () => void; onError: (e: string | null) => void }) {
  const isBool = typeof setting.value === "boolean";
  const isNumber = typeof setting.value === "number";
  const [draft, setDraft] = useState(setting.value === null ? "" : String(setting.value));
  const [busy, setBusy] = useState(false);
  const dirty = isBool ? undefined : draft !== (setting.value === null ? "" : String(setting.value));

  async function save(value: unknown) {
    setBusy(true);
    onError(null);
    try {
      await api.patch(`/settings/${setting.key}`, { value });
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? (err.body?.error === "type_mismatch" ? `${setting.key}: value must stay the same type` : `${setting.key}: save failed`) : `${setting.key}: save failed`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: 1 }}>
        <code style={{ fontWeight: 600 }}>{setting.key}</code>
        <p className="hint-text" style={{ margin: "2px 0 0" }}>{setting.description}</p>
        {setting.updatedByName && <p className="hint-text" style={{ margin: "2px 0 0" }}>Last changed by {setting.updatedByName}, {new Date(setting.updatedAt).toLocaleString("en-IN")}</p>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
        {isBool ? (
          <input type="checkbox" checked={setting.value as boolean} disabled={busy} onChange={(e) => save(e.target.checked)} />
        ) : (
          <>
            <input
              type={isNumber ? "number" : "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ width: isNumber ? 100 : 220 }}
              placeholder={setting.value === null ? "not set" : undefined}
            />
            <button
              className="btn-secondary"
              disabled={busy || !dirty}
              onClick={() => save(isNumber ? Number(draft) : draft)}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
