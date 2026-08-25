# Decisions log

Every business rule and open question we settle, in order. Per the ground rules (Section 15): thresholds not specified in the build prompt get asked, not invented.

## M0 — deployable skeleton

- **Backend:** Node 20 + TypeScript + Fastify. The build prompt (Section 12) allowed either Node+TS or Python+FastAPI and said to just pick one — picked Node so the backend, web console, and mobile app (Expo/React Native) can eventually share TypeScript types, which matters for one person maintaining this.
- **Mobile:** React Native (Expo) — not scaffolded yet. Per Section 13, M0 is infra only; the app starts at M2.
- **Web console:** plain React (Vite) — not scaffolded yet. Per Section 13's build-order note, the web POS shell arrives by M4; full parity is M13.
- **Database:** PostgreSQL 16, run in Docker alongside the API for now (Section 12 calls Postgres non-negotiable; managed vs self-hosted is an infra choice you can change later without touching the app).
- **Migrations:** node-pg-migrate — plain, reversible SQL/JS migration files, run as an explicit deploy step (`deploy.sh`), never automatically on boot (Section 12B.2, Section 15).
- **Monorepo:** npm workspaces (`apps/*`, `packages/*`). No extra tooling (pnpm/turborepo) — kept to what ships with Node, per "optimise for one person maintaining it."
- **Reverse proxy / TLS:** Caddy, automatic Let's Encrypt renewal, per Section 12B.1.
- **Theme tokens created in M0** (`packages/theme`) per Section 12C.5. This environment can't reach `dipashamedicalstore.in` directly, so the values weren't pulled from the live CSS — they were read visually off the logo and a homepage screenshot the owner provided instead: `brandGreen #167A4B`, `brandGreenDark #0F5C39`, `brandGreenTint #EAF7F1`, near-black heading text, grey body text. Close estimates, not pixel-sampled. **Open item: swap in exact hex codes from the site's stylesheet if pixel-perfect matching ever matters** (see `packages/theme/README.md`).
- **Logo carries a third colour** (orange-red, on the ring and one pill capsule in the mark) that Section 12C's "white and green" framing didn't anticipate. Site chrome itself — buttons, headings, backgrounds — is white/green throughout with no orange visible, so it's excluded from the token set for now. Not used anywhere unless asked for later (e.g. a WhatsApp-styled accent).

## Open questions carried forward (not blocking M0)

- 🔧 Section 3: do riders get onboarded by the Store Manager in-app, or will you create their accounts yourself? Relevant starting M11 (rider role) — will ask again when we get there if not answered before.
- Every configurable threshold mentioned in the doc (batch window default 8 min, expiry block default 6 months, cycle count default 10 bins/day, credit limit warnings, write-off approval values, etc.) is a **default from the doc**, to be confirmed or changed once we build the settings table in M1. None are hardcoded without a settings row.
