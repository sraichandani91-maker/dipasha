# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M10 — Delivery channel: order entry, pick list, packing verify; Section 7A unstructured-order intake

What exists right now:
- `apps/web` — two new screens. **Delivery orders**: build a delivery order (catalogue lines via the same unified search everywhere else, a free-text note, and/or prescription/strip photos — mixed orders are one order, not three), a Pending Orders queue with an age indicator, a review screen (customer's input on the left, the order being assembled on the right per Section 7A.3) to resolve each line, verify a prescription, send a quote, and record the customer's acceptance. **Pick & pack**: the walk-path-sorted pick list with scan/confirm and short-pick-with-substitute handling, and a blind-verify packing checklist that generates the delivery invoice on completion.
- `apps/api` — `orders` + `order_lines` + `order_images` + `order_pick_lines` (doubling as both pick list and packing checklist) + `delivery_batches` + `order_messages`. One order model covers both Section 7's structured "day one" order entry and Section 7A's unstructured intake — an order with only catalogue lines skips straight to confirmed, one with free text or images must pass through review first. Pick lines are generated once via FEFO and pinned to their exact batch, reused unchanged at pack time (Section 6A.8: invoice generated at pack time) via the same manual-batch-override path POS already has, so the invoice always matches what a picker physically scanned. A new `cod_pending` tender type records the pack-time invoice honestly as "not yet collected" (a delivery order is COD, paid on handover) rather than pretending cash was already in hand.
- Three new WhatsApp triggers (order confirmed, quote, partially-available) reuse the Section 12A dispatcher from M8 exactly. "Out for delivery" / "delivered" (Section 12A.2) are deferred to M11, since they need rider data that doesn't exist until then.
- Customer-app screens (Section 7A.1's intake UI) are out of scope per Section 2 — staff build/review orders on the customer's behalf (phone, WhatsApp relayed manually) until the customer app and WhatsApp inbound (M13) exist.
- One real bug caught and fixed during this milestone's own live verification: prescription verification updated the `rx_verified` flag but never moved the order out of `awaiting_prescription`, so a verified order had no route back into picking — a genuine dead end, reproduced live with a real Schedule-H product and fixed. See `DECISIONS.md`.
- Everything from M2–M9: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO, sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, Section 10A statutory reports, prescriber master, margin/scheme reporting, credit customers with ageing, pack-aware reorder, vendor comparison, the Section 12A WhatsApp notification dispatcher, and AI invoice scanning
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, `notification_log` (WhatsApp queue + send log), `purchase_invoice_scans` + `purchase_invoice_scan_pages` + `vendor_product_aliases` (AI invoice scanning), `orders` + `order_lines` + `order_images` + `order_pick_lines` + `delivery_batches` + `order_messages` (delivery channel), and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M10**, done pending sign-off — the delivery channel (Section 7: order entry, walk-path pick list, blind-verify packing) and Section 7A's unstructured-order intake, order states, and staff Pending Orders review queue. Scoped to exactly what M10's own build-order bullet names — customer-app intake screens stay out of scope per Section 2, and "out for delivery"/"delivered" WhatsApp triggers wait for M11's rider data. Verified end to end against the real running API/Postgres, through both the API directly and the web console: a structured catalogue order created → picked (FEFO batch pinned, walk-path sequenced) → packed → a real delivery invoice generated with the batch actually scanned; an unstructured free-text-plus-catalogue order → reviewed → resolved → quoted → confirmed → picked; a short pick with a substitute applied for part of the shortfall → packed as `partially_available` with the correct WhatsApp notification; and the Section 7A.4 prescription-verification gate (`awaiting_prescription` → verify → resumes into picking). One real bug was caught and fixed during this verification — prescription verification never actually cleared the `awaiting_prescription` gate, a genuine dead end — see `DECISIONS.md`. Next: **M11**.
