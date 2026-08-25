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
- **Theme tokens created in M0** (`packages/theme`) per Section 12C.5, but populated with **placeholder** colours, not the real site palette — this build environment's network egress is blocked to `dipashamedicalstore.in`, so the stylesheet couldn't be read. **Open item: replace `packages/theme/src/tokens.ts` and `tokens.css` with the real hex values before any UI ships (M2).** Either fetch them yourself and hand them to a future session, or run a session with access to that domain.

## Open questions carried forward (not blocking M0)

- 🔧 Section 3: do riders get onboarded by the Store Manager in-app, or will you create their accounts yourself? Relevant starting M11 (rider role) — will ask again when we get there if not answered before.
- Every configurable threshold mentioned in the doc (batch window default 8 min, expiry block default 6 months, cycle count default 10 bins/day, credit limit warnings, write-off approval values, etc.) is a **default from the doc**, to be confirmed or changed once we build the settings table in M1. None are hardcoded without a settings row.
