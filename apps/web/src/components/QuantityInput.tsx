import { useState } from "react";

/**
 * THE dual-entry quantity control (Section 5A.2) — built once, reused on
 * every screen that takes a quantity: purchase entry now, billing/counts/
 * issues/write-offs later. Do not implement this a second time anywhere.
 *
 * Strips (left) + loose (right), auto-carrying on blur, with an optional
 * boxes tier for purchase screens only (never shown on a sale screen,
 * per Section 5A.2 — that's the caller's choice via `showBoxes`).
 */
export default function QuantityInput({
  packSize,
  outerPackSize,
  showBoxes,
  packLabel = "Strips",
  baseUnitLabel = "Units",
  disabled,
  disabledReason,
  onChange,
}: {
  packSize: number;
  outerPackSize?: number | null;
  showBoxes?: boolean;
  packLabel?: string;
  baseUnitLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (baseUnits: number) => void;
}) {
  const [boxes, setBoxes] = useState(0);
  const [strips, setStrips] = useState(0);
  const [loose, setLoose] = useState(0);

  const nonDivisible = packSize <= 1;

  function emit(nextBoxes: number, nextStrips: number, nextLoose: number) {
    const boxStrips = showBoxes && outerPackSize ? nextBoxes * outerPackSize : 0;
    const totalBaseUnits = (boxStrips + nextStrips) * packSize + nextLoose;
    onChange(totalBaseUnits);
  }

  // Auto-carry on blur (Section 5A.2): entering more loose than a pack
  // holds rolls up automatically, visibly, so the biller sees it happen.
  function carryOnBlur() {
    if (nonDivisible || loose < packSize) return;
    const extraStrips = Math.floor(loose / packSize);
    const remainder = loose % packSize;
    setStrips((s) => s + extraStrips);
    setLoose(remainder);
    emit(boxes, strips + extraStrips, remainder);
  }

  if (nonDivisible) {
    return (
      <div>
        <label>{baseUnitLabel}</label>
        <input
          type="number"
          min={0}
          value={loose || ""}
          onChange={(e) => { const v = Number(e.target.value) || 0; setLoose(v); emit(0, 0, v); }}
          style={{ width: 100 }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
      {showBoxes && outerPackSize && (
        <div>
          <label>Boxes ({outerPackSize} {packLabel.toLowerCase()} each)</label>
          <input
            type="number" min={0} value={boxes || ""}
            onChange={(e) => { const v = Number(e.target.value) || 0; setBoxes(v); emit(v, strips, loose); }}
            style={{ width: 70 }}
          />
        </div>
      )}
      <div>
        <label>{packLabel}</label>
        <input
          type="number" min={0} value={strips || ""}
          onChange={(e) => { const v = Number(e.target.value) || 0; setStrips(v); emit(boxes, v, loose); }}
          style={{ width: 70 }}
        />
      </div>
      <div>
        <label>{baseUnitLabel}</label>
        <input
          type="number" min={0} value={loose || ""}
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onChange={(e) => { const v = Number(e.target.value) || 0; setLoose(v); emit(boxes, strips, v); }}
          onBlur={carryOnBlur}
          style={{ width: 70 }}
        />
      </div>
      <div className="hint-text" style={{ paddingBottom: 7 }}>
        = {((showBoxes && outerPackSize ? boxes * outerPackSize : 0) + strips) * packSize + loose} {baseUnitLabel.toLowerCase()}
      </div>
    </div>
  );
}
