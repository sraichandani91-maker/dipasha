/**
 * Owner-supplied brand mark (a red incomplete ring embracing two crossed
 * medicine capsules and a green leaf) — rebuilt as inline SVG so it
 * scales cleanly at any size, needs no image asset/network round trip,
 * and can be recolored via the theme later without redrawing it.
 */
export default function Logo({ size = 32, withBadge = false }: { size?: number; withBadge?: boolean }) {
  const mark = (
    <svg width={size} height={size} viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle
        cx="100" cy="98" r="80" fill="none" stroke="#F0421E" strokeWidth="11"
        strokeDasharray="450 55" strokeLinecap="round" transform="rotate(-60 100 98)"
      />
      <path d="M35,142 C58,190 148,192 168,132 C140,162 78,170 35,142 Z" fill="#0F7A4C" />
      <g transform="translate(85,96) rotate(-18)">
        <clipPath id="dipasha-logo-cap-l"><rect x="-17" y="-40" width="34" height="80" rx="17" ry="17" /></clipPath>
        <rect x="-17" y="0" width="34" height="40" clipPath="url(#dipasha-logo-cap-l)" fill="#0F7A4C" />
        <rect x="-17" y="-40" width="34" height="80" rx="17" ry="17" fill="none" stroke="#0F7A4C" strokeWidth="6" />
      </g>
      <g transform="translate(132,78) rotate(38)">
        <clipPath id="dipasha-logo-cap-r"><rect x="-13" y="-30" width="26" height="60" rx="13" ry="13" /></clipPath>
        <rect x="-13" y="-30" width="26" height="30" clipPath="url(#dipasha-logo-cap-r)" fill="#F0421E" />
        <rect x="-13" y="-30" width="26" height="60" rx="13" ry="13" fill="none" stroke="#F0421E" strokeWidth="5" />
      </g>
    </svg>
  );

  if (!withBadge) return mark;

  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size + 10, height: size + 10, borderRadius: "50%", background: "#fff", flexShrink: 0,
      }}
    >
      {mark}
    </span>
  );
}
