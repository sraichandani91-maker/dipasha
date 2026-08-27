# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M13.4 — Product master parity (part of M13, in progress)

M13 (Section 10.2: full web read/write parity, plus the SQL console/dashboards and WhatsApp inbound inbox) is the largest milestone in the build order, and is being built as a sequence of chunks rather than one pass — M13.1 (Staff & roles), M13.2 (manual-override infrastructure), M13.3 (Inventory), and M13.4 (Product master) are done and verified; the rest of M13 is tracked but not yet built (see "Build order" below).

What exists right now:
- `apps/web` — **Products** gained three tabs alongside the existing catalogue: **Substitute groups** (view every generic-substitution group, link a product to another product's group or split it into its own — overriding the auto-computed value from M2, since there was no manual path before), **Bulk import** (CSV create/update of the product master behind a mandatory preview-and-confirm diff), and a barcode label-sheet download (product labels never actually had a PDF export before, despite the README implying otherwise — bins did, products didn't).
- `apps/api` — substitute-group changes are a straight `UPDATE` on the one join key every consumer (search, order-picking substitute lookup, request-book substitute finder) already reads, logged with a required note in a new `product_group_changes` table. Bulk CSV import creates new products (composition required, same as the interactive form) or updates existing ones matched by name+manufacturer — deliberately limited to the same fields (barcode, allow_loose_sale, status) the single-product edit screen already allows, never the statutory/historical fields (form, schedule, HSN, GST rate, pack size).
- `apps/web` — a new **Inventory** screen (Owner/Store Manager): a full filterable stock view, inline quantity/batch-number/expiry/MRP correction (always a reason code + an audit row), block/unblock a batch from picking, a **Move stock** tab that creates a put-away task rather than silently relocating stock — **this is also the bin-to-bin migration you asked about earlier, deferred from M11 to land in M13** — and bulk CSV for stock adjustment, bin reassignment, and price updates.
- `apps/api` / `apps/web` — the five scan-backed actions Section 10.1 names (put-away confirm, pick confirm, packing verify, rider handover, cycle count entry) all require a mandatory reason code + note when done from web, since there's still no separate scanning client. A **Manual overrides** tab on Reports lists every one of these actions.
- `apps/web` — a **Staff** screen (owner-only): create/edit/suspend staff accounts, change role, reset PIN, grant/revoke per-user permission overrides above the base role, rider onboarding, a roster view, and a per-user activity log.
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. **M13** (Section 10.2's full web read/write parity, the SQL console/dashboards, and the WhatsApp inbound inbox) is far larger than any milestone before it, so it's being built and pushed as a sequence of chunks rather than one pass. **M13.1 (Staff & roles)** is done — full account CRUD, permission overrides (enforced by extending `requireRole` itself, no per-route changes needed), rider onboarding, and a per-user activity log fed by one generic request hook. **M13.2 (manual-override infrastructure, Section 10.1)** is done — extended put-away's already-mandatory reason-code treatment to pick confirmation, packing verification, rider handover, and cycle count entry, captured once per session rather than per line, plus a new Manual Override report. **M13.3 (Inventory)** is done — full filterable stock view, quantity/batch/expiry/MRP correction with an audit row, block/unblock a batch, move-stock-between-bins and bulk bin reassignment reusing M3's put-away pipeline wholesale (**this is the bin-to-bin migration explicitly deferred from M11**), and three bulk CSV imports behind a mandatory preview-and-confirm diff. **M13.4 (Product master)** is also done — substitute-group management (linking/splitting products' `substitute_group_id`, which had no manual override since M2 despite every consumer already reading it — a straight `UPDATE` on that one join key, logged with a required note), bulk CSV import of the product master (create with required composition, update limited to the same fields the single-product edit screen already allows — never form/schedule/HSN/GST/pack size, which touch statutory and historical-sale data this milestone isn't re-litigating), and product barcode label-sheet PDF generation, which turned out to have never actually been built despite M2's README wording (only bins ever got one). Verified end to end against the real running API: linked two products into one substitute group and split one back out, confirming each change's audit row; ran a bulk CSV creating one brand-new SKU (with composition, auto-computing a real substitute group) and updating an existing one's barcode and loose-sale flag, confirming the preview correctly diffed both before commit; and downloaded a real product label-sheet PDF. Still to come in M13: bin master, order, inbound-GRN, and audit parity, a settings screen, the SQL console and prebuilt dashboards, and the WhatsApp inbound shared inbox — each its own chunk, tracked in the task list, building in the order listed in DECISIONS.md.
