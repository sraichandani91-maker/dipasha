# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M13.1 — Staff & roles (part of M13, in progress)

M13 (Section 10.2: full web read/write parity, plus the SQL console/dashboards and WhatsApp inbound inbox) is the largest milestone in the build order, and is being built as a sequence of chunks rather than one pass — M13.1 (Staff & roles) is the first, done and verified; the rest of M13 is tracked but not yet built (see "Build order" below).

What exists right now:
- `apps/web` — a new **Staff** screen (owner-only): create/edit/suspend staff accounts, change role, reset PIN, grant/revoke per-user permission overrides above the base role, rider onboarding (vehicle details + license/RC/ID photo upload), a roster view (who's online now, approximate hours this week), and a per-user activity log.
- `apps/api` — full user-account CRUD (create, suspend-as-delete, role change, PIN reset); permission overrides are enforced by extending the existing `requireRole(...)` check itself, so every route in the app respects a granted override automatically, with zero per-route changes; a generic `onResponse` hook logs every mutating authenticated request to `activity_log`, so "every action a user has taken" is structurally true rather than dependent on each route remembering to log it.
- "Logged in now" / "hours this week" are honest approximations from request recency, clearly labelled as such in the UI — this build has no real session table (stateless JWT), so there's no true presence tracking without one.
- Everything from M2–M12: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO (online and offline-first with sync-on-reconnect), sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, Section 10A statutory reports, prescriber master, margin/scheme reporting, credit customers with ageing, pack-aware reorder, vendor comparison, the Section 12A WhatsApp notification dispatcher, AI invoice scanning, the delivery channel (order entry, pick list, packing verify, Section 7A unstructured intake), and the rider/dispatch module (handover scan, delivery marking, COD reconciliation, failed-delivery returns)
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, `notification_log` (WhatsApp queue + send log), `purchase_invoice_scans` + `purchase_invoice_scan_pages` + `vendor_product_aliases` (AI invoice scanning), `orders` + `order_lines` + `order_images` + `order_pick_lines` + `delivery_batches` + `order_messages` (delivery channel), `order_gps_pings` + `delivery_return_tasks` + `rider_cash_reconciliations` (rider/dispatch), `bill_number_blocks` + `sync_conflicts` (offline sync), `permission_overrides` + `rider_details` + `rider_documents` + `activity_log` + `user_last_seen` (staff & roles), and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. **M13** (Section 10.2's full web read/write parity, the SQL console/dashboards, and the WhatsApp inbound inbox) is far larger than any milestone before it, so it's being built and pushed as a sequence of chunks rather than one pass: **M13.1 (Staff & roles)** is done — full account CRUD, role assignment, PIN reset, permission overrides (enforced by extending `requireRole` itself so it applies everywhere with no per-route changes), rider onboarding (vehicle + documents), and a real per-user activity log fed by one generic request hook rather than per-route logging calls. Verified end to end against the real running API: created a staff account, changed its role, reset its PIN, granted it an `owner`-level permission override and confirmed via a real `GET /users` call that access actually changed (200 with the override, 403 without — twice, granting and then revoking), confirmed suspending an account really blocks its next login (`account_suspended`) while suspending yourself is rejected outright, and confirmed rider vehicle details and a document upload save and read back correctly. Still to come in M13: the Section 10.1 manual-override infrastructure for scan-backed actions on web, full inventory/product/bin/order/inbound-GRN/audit parity (including the bin-to-bin stock migration explicitly deferred here from M11), a settings screen, the SQL console and prebuilt dashboards, and the WhatsApp inbound shared inbox — each its own chunk, tracked in the task list, building in the order listed in DECISIONS.md.
