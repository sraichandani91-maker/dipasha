# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M8 — WhatsApp integration: dispatcher, bill-generation notification, callback trigger, opt-out, send log

What exists right now:
- `apps/web` — a new **Notifications** screen: the full WhatsApp send log, a Failed Notifications list with a one-click Retry, and a monthly spend report (honestly ₹0 until a real provider reports a cost). **Customers** gained a WhatsApp consent panel (transactional/marketing opt-in, staff-set). POS's "Send via WhatsApp" button now goes through the same dispatcher as every other send, so a manual resend shows up in the same log as the automatic one.
- `apps/api` — the Section 12A notification dispatcher: `notification_log` doubles as both the outbound queue and the permanent send log, processed by a `setInterval` poller (no real job-queue infra for this single-VPS pilot). Two triggers wired: **bill-generated**, enqueued automatically and atomically inside `createSale`'s own transaction the moment a bill with a customer phone is saved (never delays the bill — enqueueing is just a DB insert); and **callback stock-available**, enqueued when staff reserve stock for a customer request ("Reserve & notify customer"), with Schedule H/H1/X drug names automatically redacted from the message body per Section 12A.5. Retry with backoff (2/10/30 min, 3 attempts) before a row surfaces on the Failed list. Consent (opt-in/opt-out per category) is enforced before every send.
- No real WhatsApp Business API account exists yet — delivery is a pluggable interface (`WhatsAppSender`, same pattern as M1's OTP sender) with a dev console sender that logs the exact message instead of sending it, and every "sent" status in the UI says so honestly. Wiring a real provider only touches `createWhatsAppSender`.
- Three real bugs caught and fixed during this milestone's own live verification (not left in): a transaction-visibility bug where the manual-resend path would have silently done nothing on its first-ever run; a message-content bug where the automatic bill notification always greeted "Hi," instead of the customer's actual name; and a broken-grammar artifact in the Schedule-H redaction branch. See `DECISIONS.md`.
- Everything from M2–M7: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO, sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, Section 10A statutory reports, prescriber master, margin/scheme reporting, credit customers with ageing, pack-aware reorder, and vendor comparison
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, `notification_log` (WhatsApp queue + send log), and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M8**, done pending sign-off — the Section 12A WhatsApp notification dispatcher, the bill-generated and callback-stock-available triggers, opt-out consent per customer per category, and the full send log with a Failed Notifications list and retry. Scoped to exactly what M8's own build-order bullet names (dispatcher + these two triggers + opt-out + send log) — inbound messages and the shared inbox stay M13's, per the brief's own sequencing. Verified end to end against the real running API/Postgres: a real sale enqueued its bill notification without blocking the response, the background dispatcher picked it up and processed it within one poll cycle, a real "Reserve & notify" call correctly redacted a Schedule-H product's name from the outbound text, opting a customer out correctly skipped their next send, and a manually-failed row was retried successfully through the UI. Three real bugs were caught and fixed during this verification, not left in — see `DECISIONS.md`. Next: **M9** — AI invoice scanning.
