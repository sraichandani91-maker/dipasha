# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M11 — Rider role, handover scan, delivery marking, COD reconciliation

What exists right now:
- `apps/web` — a new **My trips** screen (rider role): scan (or type) the order label to mark handover, mark reached, mark delivered with COD collection (cash/UPI amount + a delivery-proof note), mark failed with a reason code, and close an end-of-shift cash reconciliation against a server-computed expected total. **Delivery orders**' Active Orders tab gained rider assignment (a trip = every packed order sharing the same delivery batch). **Pick & pack** gained a **Returns to store** tab — the failed-delivery scan-back-into-a-bin queue.
- `apps/api` — extends the M10 order lifecycle through `assigned → out_for_delivery → delivered`/`delivery_failed`. Handover scans the order's own `order_number` as its label; GPS pings (handover/in-transit/delivered) are captured for real, browser-tab-scoped like M5's alarm. Marking delivered settles the `cod_pending` tender M10 recorded at pack time into what was actually collected. A failed delivery cancels the sale immediately but defers the stock movement until a human scans each item into a real bin (`delivery_return_tasks`) — never silently restocked. `rider_cash_reconciliations` mirrors the counter's day-close pattern, keyed per rider per day.
- Two new WhatsApp triggers (out for delivery — with rider name and number, delivered) complete the Section 12A.2 delivery funnel M10 started.
- Rider onboarding is still seed-account-only — full staff account management (Section 10.2) stays M13's job; this milestone only adds a read-only rider list for the assignment dropdown.
- Everything from M2–M10: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO, sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, Section 10A statutory reports, prescriber master, margin/scheme reporting, credit customers with ageing, pack-aware reorder, vendor comparison, the Section 12A WhatsApp notification dispatcher, AI invoice scanning, and the delivery channel (order entry, pick list, packing verify, Section 7A unstructured intake)
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, `notification_log` (WhatsApp queue + send log), `purchase_invoice_scans` + `purchase_invoice_scan_pages` + `vendor_product_aliases` (AI invoice scanning), `orders` + `order_lines` + `order_images` + `order_pick_lines` + `delivery_batches` + `order_messages` (delivery channel), `order_gps_pings` + `delivery_return_tasks` + `rider_cash_reconciliations` (rider/dispatch), and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M11**, done pending sign-off — Section 8's rider/dispatch module: trip assignment, handover scan, in-transit marking, COD collection settling the pack-time invoice, end-of-shift cash reconciliation, and failed-delivery returns that are never silently restocked. Scoped to exactly what M11's own build-order bullet names — rider onboarding (account creation, vehicle/documents) stays M13's job, and internal WhatsApp alerts (Section 12A.3) stay deferred alongside the rest of that section since M8. Verified end to end against the real running API/Postgres, through both the API directly and the web console with two separate browser sessions (owner and rider): a packed order assigned to a rider → handed over (order-number scan + real GPS ping) → reached → delivered with COD collected, settling the order's `cod_pending` tender into `cash` for the exact amount, with two more GPS pings (in-transit, delivered) captured along the way; a second order taken to `out_for_delivery` and marked failed, which cancelled its sale immediately but left stock untouched until a return task was scan-confirmed into a real bin (stock only changed at that confirm step, not at the failure); and a rider's end-of-shift cash reconciliation showing a genuine ₹1.20 variance, visible on the Owner's list. Next: **M12**.
