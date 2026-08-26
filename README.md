# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M4 — counter POS and GST billing, stock_issue, sale returns, day-close

What exists right now:
- `apps/web` — everything from M2/M3, plus **Billing (POS)**: the counter sale screen, keyboard-friendly, with the same unified search and dual-entry quantity control as the rest of the app, FEFO batch selection shown live, per-line and blended margin display (Owner only — the field is genuinely absent from the response for anyone else), a zero-margin discount floor, Schedule H/H1 prescriber capture (soft, never blocking), hold/recall, cash/UPI/card/credit tendering with live change-due, and a printable receipt
- The dual-entry `QuantityInput` component (Section 5A.2, built in M3) now proven out on a second real screen, exactly as intended — strips + loose, auto-carrying on blur
- `apps/api` — everything from M2/M3, plus counter sales (`sales`/`sale_lines`/`sale_tenders`), gapless bill and credit-note numbering, FEFO allocation with automatic multi-batch line-splitting, `stock_issue` (non-GST outbound, FEFO by default with logged override), sale returns as GST credit notes (good stock back to its bin, damaged to quarantine, hard-blocked on expired stock), full bill cancellation before day-close, and day-close cash reconciliation (expected cash always server-computed from real tenders, never trusted from the client) — see `apps/api/MIGRATIONS.md` and `DECISIONS.md`
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
- Seed script: 4 role users, 25 salts, 50 dummy SKUs (auto-grouped into real substitute groups), 59 bins across every zone prefix, batches with opening stock
- `packages/theme` — shared design tokens (estimated from the real logo/site screenshot — see `packages/theme/README.md`)
- Docker Compose: Postgres + API + web (nginx) + Caddy (automatic HTTPS, path-split `/api/*` vs the console)
- CI: typecheck, build, and a Docker smoke test for both the api and web images on every push
- `deploy.sh` + `RUNBOOK.md`: how to actually get this running on a VPS

## Repo layout

```
apps/
  api/            Fastify backend
    migrations/   node-pg-migrate files (schema, in order)
    scripts/seed.ts  Dev seed data — 50 SKUs, bins, batches, opening stock
    src/domain/   Business rules shared across routes/seed (e.g. substitute grouping)
    MIGRATIONS.md How the migration/seed workflow works
  web/            React + Vite owner/staff console
packages/
  theme/          Shared design tokens (colors, spacing) — web + app both import this
infra/
  Caddyfile       Reverse proxy config (templated with $DOMAIN, splits /api/* from the console)
docker-compose.yml
deploy.sh         Deploy script for the VPS
RUNBOOK.md        How to deploy and operate this, without needing me
DECISIONS.md      Every business rule and stack choice, and why
```

## Local development

```
cp .env.example .env          # set POSTGRES_PASSWORD and JWT_SECRET (openssl rand -hex 32)
docker compose up -d postgres
npm install
npm run migrate:up --workspace apps/api
npm run seed --workspace apps/api   # optional: 50 dummy SKUs to test against
npm run dev:api                     # terminal 1 — API on :3000
npm run dev --workspace apps/web    # terminal 2 — console on :5173, proxies /api to :3000
```

Open http://localhost:5173. Log in as the seeded owner with phone `+919999900001` — in development the OTP screen shows the code directly (no real SMS provider is wired up yet). PIN for all seeded users is `1234`.

## Full stack via Docker

```
cp .env.example .env   # set POSTGRES_PASSWORD and JWT_SECRET at minimum
docker compose up -d --build
docker compose exec api npm run migrate:up --workspace apps/api
curl http://localhost:3000/health   # api
curl http://localhost:8080/         # web console
```

See `RUNBOOK.md` for deploying to a real VPS with HTTPS on a subdomain.

## Build order

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M4**, done pending sign-off — per the doc, "the first milestone that earns money": the shop can now run a full counter sale, start to finish, on this system. Next: **M5** — customer request book, inline product creation, PO generation from open requests plus low stock, callback queue and stock reservation, plus the 6 PM daily review alarm.
