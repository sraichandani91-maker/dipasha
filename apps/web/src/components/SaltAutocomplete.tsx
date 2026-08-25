import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

interface SaltMatch {
  id: string;
  name: string;
  matchedOn: "name" | "synonym";
  synonym: string | null;
}

// Backs Section 6B.2's "typed against a salt master that grows as you
// add — with autocomplete, so 'Paracetamol' is not also entered as
// 'Paracetamol IP' and 'PCM'". Typing a name with no match is still a
// valid choice — it becomes a new salt master entry on save.
export default function SaltAutocomplete({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: string) => void;
}) {
  const [suggestions, setSuggestions] = useState<SaltMatch[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const res = await api.get(`/salts?q=${encodeURIComponent(value)}`);
      setSuggestions(res);
    }, 150);
  }, [value]);

  return (
    <div style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Salt / composition"
        style={{ width: "100%" }}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)", maxHeight: 180, overflowY: "auto",
        }}>
          {suggestions.map((s) => (
            <div
              key={s.id}
              onMouseDown={() => { onChange(s.name); setOpen(false); }}
              style={{ padding: "6px 10px", cursor: "pointer", fontSize: 13 }}
            >
              {s.name}
              {s.matchedOn === "synonym" && <span className="hint-text"> (matched "{s.synonym}")</span>}
            </div>
          ))}
        </div>
      )}
      {value.trim() && suggestions.length === 0 && (
        <p className="hint-text" style={{ marginTop: 2 }}>New salt — will be added to the salt master on save.</p>
      )}
    </div>
  );
}
