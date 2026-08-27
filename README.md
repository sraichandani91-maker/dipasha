# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M13.6 — Orders parity (part of M13, in progress)

M13 (Section 10.2: full web read/write parity, plus the SQL console/dashboards and WhatsApp inbound inbox) is the largest milestone in the build order, and is being built as a sequence of chunks rather than one pass — M13.1 (Staff & roles), M13.2 (manual-override infrastructure), M13.3 (Inventory), M13.4 (Product master), M13.5 (Bin master), and M13.6 (Orders) are done and verified; the rest of M13 is tracked but not yet built (see "Build order" below).

What exists right now:
- `apps/web` — **Delivery orders** gained an **All orders** tab (status/date-range/search filters, CSV export) and, on the order review screen, an **Order actions** panel: **Cancel order** (reason code + required note, blocked once already terminal or already dispatched — a dispatched order points staff at the Rider screen's delivery-failure flow instead), **Force-reassign rider** (rider picker + required note, shown only while `assigned`/`out_for_delivery`, explicit that it only corrects the system record), and a **refund-initiation stub** (amount + reason, clearly labelled as recording intent only — no payment gateway). Pre-pick order editing (add a catalogue item, remove a line, change quantity, substitute) now works across the *whole* pre-pick window, not just the first two statuses.
- `apps/api` — order cancellation needed zero new stock-reversal logic: stock is never deducted until pack time, so only `packed`/`partially_available` orders (which already have a `sale_id`) reuse the existing `cancelSale` (Section 6A.7, day-close-blocked, full reversal); every earlier status is a pure status flip. Force-reassign is a real audit trail (`order_reassignments`) with a required note rather than a reason-code enum, same character as M13.4/M13.5's judgment-call logs. Refunds (`order_refunds`) start and stay at `requested` — there's nowhere else for them to go until a real payment gateway exists.
- `apps/web` — **Bins** gained a **Rack map** tab: a real grid of aisles/bays/shelf levels, each bin coloured by how full it is (against its own capacity score) with its stock value shown, and drag-one-bin-onto-another to reslot — which queues a put-away task exactly like the Inventory screen's Move stock, never a silent record change. The list view gained **Rename**, **Retire** (blocked with a clear error if the bin still holds stock), and **Merge into…** (queues a move task for everything currently in the bin; the source bin can only actually be retired once every task is scan-confirmed).
- `apps/api` — retiring a bin now hard-blocks while it holds recorded stock, the same character as the cold-chain/SH1 zone-forcing rule — a physical-consistency issue, not a judgment call. Merge and drag-to-reslot are both built entirely on M3's put-away pipeline and M13.3's Inventory move-stock endpoint — no new stock-movement code in this milestone at all. A real gap fixed in passing: bins created via the web form (code only) never had their aisle/bay/shelf parsed out even when the code structurally encoded them, which would have made them invisible to the rack map — fixed for every future bin regardless of how it's created.
- `apps/web` — **Products** has substitute-group management, bulk CSV import with preview-diff, and barcode label-sheet PDFs (a genuine gap — only bins ever had one before).
- `apps/web` — a new **Inventory** screen: full filterable stock view, quantity/batch/expiry/MRP correction with an audit row, block/unblock a batch, Move stock (**the bin-to-bin migration you asked about earlier, deferred from M11**), and bulk CSV import.
- `apps/api` / `apps/web` — the five scan-backed actions Section 10.1 names all require a mandatory reason code + note when done from web. A **Manual overrides** tab on Reports lists every one.
- `apps/web` — a **Staff** screen (owner-only): full account CRUD, permission overrides, rider onboarding, roster, activity log.
- Everything from M2–M12: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO (online and offline-first with sync-on-reconnect), sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, Section 10A statutory reports, prescriber master, margin/scheme reporting, credit customers with ageing, pack-aware reorder, vendor comparison, the Section 12A WhatsApp notification dispatcher, AI invoice scanning, the delivery channel (order entry, pick list, packing verify, Section 7A unstructured intake), and the rider/dispatch module (handover scan, delivery marking, COD reconciliation, failed-delivery returns)
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, `notification_log` (WhatsApp queue + send log), `purchase_invoice_scans` + `purchase_invoice_scan_pages` + `vendor_product_aliases` (AI invoice scanning), `orders` + `order_lines` + `order_images` + `order_pick_lines` + `delivery_batches` + `order_messages` (delivery channel), `order_gps_pings` + `delivery_return_tasks` + `rider_cash_reconciliations` (rider/dispatch), `bill_number_blocks` + `sync_conflicts` (offline sync), `permission_overrides` + `rider_details` + `rider_documents` + `activity_log` + `user_last_seen` (staff & roles), `web_manual_overrides` (manual-override reasons for actions with no ledger row of their own), `batch_corrections` (non-quantity stock-edit audit trail), `product_group_changes` (substitute-group override audit trail), and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. **M13** (Section 10.2's full web read/write parity, the SQL console/dashboards, and the WhatsApp inbound inbox) is far larger than any milestone before it, so it's being built and pushed as a sequence of chunks rather than one pass. **M13.1 (Staff & roles)** is done — full account CRUD, permission overrides enforced by extending `requireRole` itself, rider onboarding, a per-user activity log. **M13.2 (manual-override infrastructure)** is done — mandatory reason codes for pick/pack/handover/cycle-count entry on web, a new Manual Override report. **M13.3 (Inventory)** is done — full filterable stock view, quantity/batch/expiry/MRP correction with an audit row, block/unblock a batch, move-stock-between-bins reusing M3's put-away pipeline (**the bin-to-bin migration explicitly deferred from M11**), three bulk CSV imports with preview-diff. **M13.4 (Product master)** is done — substitute-group management (a straight `UPDATE` on the join key every consumer already reads, no override path existed before), bulk product CSV import, and product barcode label-sheet PDFs (a genuine gap — only bins ever had one). **M13.5 (Bin master)** is also done — rename and retire were already technically possible since M2 (`code`/`status` were always updatable), but retiring a bin with recorded stock had no safety check; it's now a hard block, same character as the cold-chain zone-forcing rule. "Merge" queues a put-away task per item in the source bin rather than combining records directly, which composes naturally with the new retire-block: a merged-from bin can't actually be retired until every queued task is scan-confirmed. The visual rack map (aisle/bay/shelf grid, fill % against each bin's existing `capacity_score`, value heat) and drag-to-reslot are built entirely on M13.3's Inventory move-stock endpoint — no new stock-movement code. A real gap fixed in passing: bins created via the web form never had aisle/bay/shelf parsed from their code even when it structurally encoded them, which would have made them invisible to the rack map. Verified end to end against the real running API: retiring a stocked bin correctly 409s with the exact quantity; merging one bin into another queued a real put-away task, left the source bin blocked from retirement until the task was scan-confirmed, then retirement succeeded; the rack map correctly showed real fill/value data pulled from live stock, including one bin honestly displaying over 100% fill rather than clamping the number. **M13.6 (Orders)** is also done — manual creation and the full filterable/exportable order list reused M10's existing order-entry form and a new `GET /orders` (CSV via the same `toCsv` helper Section 10A's reports use); edit-pre-pick (add/remove/change-quantity/substitute) needed only two new endpoints, since quantity-change and substitution both reuse M10's existing line-resolve endpoint once its web-side gating was widened to the full pre-pick window. Cancel-with-reversal needed zero new stock-reversal logic — stock is never deducted until pack time, so only `packed`/`partially_available` orders (already carrying a `sale_id`) reuse the existing `cancelSale` from M4/M13.3; every earlier status is a pure status flip. Force-reassign-rider is a real audit trail with a required note (same character as M13.4/M13.5's judgment-call logs), explicitly limited to `assigned`/`out_for_delivery` and explicit that it only corrects the system record. Refund initiation is a deliberately inert stub per Section 10.2's own wording — records intent, never fakes a "processed" state. Verified end to end against the real running API: a pre-pick order edited (line added, then removed) via the catalogue search; a `received`-stage order cancelled with zero ledger activity; a freshly packed order (real sale, open business day) cancelled with the batch's stock correctly reversed back to its exact pre-sale figure; a cancel against a closed-business-day sale correctly 409ing via the reused guard rail; a dispatched order's rider force-reassigned with the audit row written and a same-rider no-op correctly rejected. Live verification also caught and fixed a real bug — the order-actions panel was hiding a recorded refund the moment its order reached a terminal status, since the whole panel (not just cancel/reassign) disappeared once terminal; refunds now stay visible regardless of order status. Still to come in M13: inbound-GRN and audit parity, a settings screen, the SQL console and prebuilt dashboards, and the WhatsApp inbound shared inbox — each its own chunk, tracked in the task list, building in the order listed in DECISIONS.md.
