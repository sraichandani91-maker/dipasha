# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M3 — GST purchase entry, stock_received, put-away

What exists right now:
- `apps/web` — phone+OTP login, product master (list + create, with salt-master autocomplete and duplicate detection), bin master (list + create), the unified search of Section 5B, a printable A4 bin-label sheet download, owner role-impersonation with a visible banner, **GST purchase entry** (a real distributor-invoice-shaped line grid with live reconciliation preview), **stock received** (non-GST inbound), and the **put-away queue** (manual bin confirm with mandatory reason, since the web console has no scanner — Section 10.1)
- The dual-entry `QuantityInput` component (Section 5A.2) — strips + loose, auto-carrying on blur — built once in M3, meant to be reused by every future screen that takes a quantity (billing, counts, issues, write-offs)
- `apps/api` — Fastify + TypeScript API: `/health`, phone+OTP login, JWT access/refresh, PIN idle-lock re-auth, owner impersonation, role-gated `/products`, product/bin/vendor CRUD, `/search`, bin label-sheet PDF generation, GST purchase invoices (landed-cost computation including free-quantity apportionment, CGST/SGST/IGST split by vendor state, reconciliation tolerance, near-expiry and duplicate-invoice checks), `stock_received`, and put-away tasks with hard-enforced cold-chain/Schedule-H1 bin zoning (see `apps/api/MIGRATIONS.md` and `DECISIONS.md`)
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M3**, done pending sign-off. Next: **M4** — counter POS and GST billing, `stock_issue`, sale returns, day-close. The first milestone that earns money.
