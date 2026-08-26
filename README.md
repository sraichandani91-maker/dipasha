# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M7 — trade practices: prescribers, margin/scheme tracking, credit customers, pack-aware reorder, vendor comparison

What exists right now:
- `apps/web` — everything from M2–M6, plus four new screens: **Prescribers** (directory + create, sales-by-prescriber/molecule-mix/new-prescribers/dropped-volume reports), **Margins** (Owner only — by SKU/schedule-category/vendor, below-cost sales, scheme shortfalls), **Customers** (credit-customer search, credit settings, balance check, payment recording, statement, and an ageing report), and **Vendor comparison** (per-vendor minimum-order-pack editing, rate-rise flags, the vendor scorecard). POS gained prescriber autocomplete (attach a real prescriber to an H/H1 sale, not just free text) and a credit-tender balance check before completing a credit sale. Purchase orders gained a near-expiry clearance-candidates section and a "rounded to MOQ" badge on suggested quantities.
- `apps/api` — prescriber master with trigram-search autocomplete; margin reporting on effective cost (never invoice rate) by SKU/category/vendor, a below-cost-sale flag, and scheme (promised-vs-actual) shortfall tracking; credit customers with family/account grouping, credit limits, oldest-first payment allocation written at record time, and an ageing report; pack-aware reorder quantities (vendor MOQ rounding) with near-expiry stock diverted out of reorder suggestions into its own clearance list; multi-vendor rate comparison, rate-rise flags, and a vendor scorecard (lead time, fill rate) built on a new PO→invoice link
- Full data model addition: `prescribers`, `customer_payments`, `customer_payment_allocations`, plus new columns on `sale_prescriber_details` (prescriber_id), `purchase_invoice_lines` (promised quantities for scheme tracking), `customers` (credit_enabled/credit_limit/payment_terms_days/account_customer_id), `vendors` (default_min_order_pack_units), `products` (seasonality_multiplier), and `purchase_invoices` (purchase_order_id)
- A real bug caught and fixed during this milestone's own verification: credit tender had no upper bound, so over-tendering credit silently inflated a customer's permanent balance — see `DECISIONS.md`
- **Post-M7 addition, owner-requested**: POS now offers "Print receipt" / "Send via WhatsApp" once a bill is saved. WhatsApp delivery is a pluggable interface (same pattern as OTP delivery) — a dev sender logs the message honestly as "not actually sent" until the owner provides real WhatsApp Business API credentials; resends are tracked (`whatsapp_send_count`), same as reprints
- Everything from M2–M6: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO, sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, and the Section 10A statutory reports
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M7**, done pending sign-off — prescriber master with autocomplete and commercial-intelligence reports, margin reporting on effective cost with a below-cost flag and scheme (promised-vs-actual) tracking, credit customers with family grouping/limits/ageing/payment recording, pack-aware reorder (vendor MOQ rounding, near-expiry clearance diversion), and multi-vendor rate comparison with a lead-time/fill-rate scorecard. Verified end to end: a real H-schedule sale linked to a real prescriber via autocomplete; a real below-cost sale correctly flagged; a real PO created and partially invoiced showed the correct 60% fill rate on the scorecard; a real credit-tender-overage bug was caught and fixed live, then re-verified as rejected. Next: **M8** — WhatsApp/notification integration.
