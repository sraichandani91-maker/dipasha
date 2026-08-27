# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M12 — Offline mode and sync ledger, POS offline-first

What exists right now:
- `apps/web` — POS now works while genuinely offline: a cached product/batch/stock snapshot (refreshed while online), a pool of pre-reserved bill numbers, an offline product picker in place of the online search bar, and a real IndexedDB outbox that queues a completed sale locally and auto-syncs the moment the browser tab is back online. A queued-offline sale prints its own distinct "OFFLINE — QUEUED FOR SYNC" receipt, with an estimated GST-inclusive total computed the same way the server will compute the real one. **Reports** gained a **Sync conflicts** tab — any sync that can't cleanly replay (e.g. stock ran out server-side in the meantime) is durably logged and surfaced to the Owner, never silently auto-resolved.
- `apps/api` — bill numbers can be reserved in small blocks per device (`bill_number_blocks`); `createSale` gained an idempotency key so a retried sync can never double-create a sale, plus a pre-assigned-bill-number and real-occurred-at path for replaying an offline sale with its original bill number and timestamp; `sync_conflicts` durably records anything that doesn't cleanly replay, with an Owner-facing resolve action.
- Offline FEFO allocation mirrors the server's own logic (same `sellable_stock` view the online allocator reads from) and pins the offline-chosen batch via the existing manual-batch-override mechanism, so sync-time replay can never silently pick a different batch than what was shown offline.
- **Scoped to POS billing only, per this milestone's own build-order bullet.** Picking, packing, cycle counting, and put-away also need offline support per Section 11, and will reuse this same outbox/sync mechanism — not built yet, a named next step rather than a silent gap.
- Everything from M2–M11: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO, sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, Section 10A statutory reports, prescriber master, margin/scheme reporting, credit customers with ageing, pack-aware reorder, vendor comparison, the Section 12A WhatsApp notification dispatcher, AI invoice scanning, the delivery channel (order entry, pick list, packing verify, Section 7A unstructured intake), and the rider/dispatch module (handover scan, delivery marking, COD reconciliation, failed-delivery returns)
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, `notification_log` (WhatsApp queue + send log), `purchase_invoice_scans` + `purchase_invoice_scan_pages` + `vendor_product_aliases` (AI invoice scanning), `orders` + `order_lines` + `order_images` + `order_pick_lines` + `delivery_batches` + `order_messages` (delivery channel), `order_gps_pings` + `delivery_return_tasks` + `rider_cash_reconciliations` (rider/dispatch), `bill_number_blocks` + `sync_conflicts` (offline sync), and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M12**, done pending sign-off — Section 6A.9/Section 11's offline mode: block-reserved bill numbers, an idempotency-keyed sync path so a retried sync can never double-create a sale, offline FEFO allocation pinned to the exact batch chosen offline, and durable `sync_conflicts` escalation so nothing gets silently auto-resolved behind the Owner's back. Scoped to POS billing only, per M12's own build-order bullet — picking/packing/counting/put-away offline support (also named in Section 11) reuses the same outbox/sync mechanism but isn't wired to those screens yet, a named next step rather than a silent gap. Verified end to end against the real running API/Postgres via Playwright, using the browser's real `navigator.onLine`/offline simulation: went offline mid-session, added a line via the offline product cache, completed a sale that was queued locally with an estimated GST-inclusive total and a bill number drawn from a pre-reserved pool, reconnected, watched it auto-sync, and confirmed via `psql` that it landed server-side as a real `sales` row with the correct bill number, business date (from the original offline timestamp, not sync time), and grand total (₹100.80, matching the offline estimate exactly). The sync-conflict escalation path was verified via a deliberately oversized offline sale, which correctly produced a durably-logged conflict resolvable from the Owner's new Sync conflicts report tab. Two real bugs were found and fixed along the way: a discount-split bug that silently dropped discount on any line FEFO-split across multiple batches, and a missing-GST bug in the offline receipt's estimated total. Next: **M13**.
