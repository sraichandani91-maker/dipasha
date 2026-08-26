# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M9 — AI invoice scanning: capture, extract, match/review, commit

What exists right now:
- `apps/web` — a new **Scan invoice** screen: upload a PDF or photo(s) of a distributor invoice, watch it extract (vendor picked first, then a Claude vision call fills in header + line data with per-field confidence), review/correct against the source image shown side by side, resolve each line against an existing SKU (top-3 fuzzy candidates, or create a new SKU inline without leaving the screen), and commit straight into the same purchase-invoice pipeline manual entry uses — same duplicate-invoice/near-expiry/reconciliation checks, no separate rules for a scanned invoice.
- `apps/api` — `purchase_invoice_scans` + `purchase_invoice_scan_pages` track each scan's image(s), raw extraction, status, and (once committed) the linked purchase invoice and a diff of what the reviewer corrected, feeding a vendor-accuracy report over time. `vendor_product_aliases` remembers a vendor's own product-name spelling once a human confirms a match, so repeat invoices from the same vendor need fewer corrections. Image-hash caching skips re-billing Claude on an accidental duplicate upload. Extraction goes through the official `@anthropic-ai/sdk` (`messages.parse()` + a Zod schema, a vision-capable model, per Section 6.3), behind a pluggable/owner-configurable model setting, not hardcoded.
- **The Section 6.3 fallback is a first-class path, not an afterthought**: if extraction fails for any reason, the review screen still opens — same screen, empty line table, visible error banner, image still there — never a dead end. A committed fallback scan is honestly logged `entry_method = 'manual'` since no AI output actually fed it.
- The owner's Anthropic account currently has a zero credit balance, so the one thing not yet verified live is a genuinely successful extraction call — everything else (capture, storage, the review UI, manual correction, inline SKU creation, commit, the fallback path itself, duplicate-invoice rejection reused from M6) has been verified end to end against the real running system, including the fallback path being deliberately exercised for real rather than only reasoned about. Re-verify the extraction happy path the moment credits are added.
- Five real bugs caught and fixed during this milestone's own live verification (the most of any milestone so far): an image-hash cache false-positive on a previously-failed upload, a bug that rejected the fallback path from ever committing (directly breaking the "never a dead end" requirement), a JSON-`"null"`-vs-SQL-`NULL` bug in the corrected-fields diff, a missing `file_path` column in the page-serving query, and a stale-closure bug that left the review screen's image panel stuck on "Loading page 1…". See `DECISIONS.md`.
- Everything from M2–M8: product/bin/vendor masters, GST purchase entry, put-away, POS billing with FEFO, sale returns, day-close, customer request book, purchase orders, callback loop, daily review alarm, cycle counts, expiry audit, damage/write-off with photo evidence, Section 10A statutory reports, prescriber master, margin/scheme reporting, credit customers with ageing, pack-aware reorder, vendor comparison, and the Section 12A WhatsApp notification dispatcher (bill-generated + callback triggers, opt-out, send log, retry)
- Full data model: settings, users/roles, salt master, product master + composition child table, bin master, batches, search log, vendors, purchase invoices + lines, put-away tasks, sales + lines + tenders + prescriber details, credit notes, day-close, cycle counts, write-offs, `notification_log` (WhatsApp queue + send log), `purchase_invoice_scans` + `purchase_invoice_scan_pages` + `vendor_product_aliases` (AI invoice scanning), and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
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

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M9**, built and verified pending one external blocker — AI invoice scanning per Section 6.3: capture (PDF or photos), extract via a vision-capable LLM with structured output, match/review against existing SKUs with inline new-SKU creation, and commit into the same purchase-invoice pipeline manual entry uses. Scoped to exactly what M9's own build-order bullet names. Verified end to end against the real running API/Postgres: upload → review screen → manual correction → commit → GRN/ledger rows, inline SKU creation, vendor selection driving alias lookups, a reused invoice number correctly rejected by the same duplicate check M6 already enforces, and — repeatedly, since the owner's Anthropic account currently has a zero credit balance — the Section 6.3 fallback path itself (extraction fails → same review screen opens with an empty table and a visible error banner → still commits, honestly labelled `entry_method = 'manual'`). The one path not yet verified live is a genuinely successful extraction call, since every real call to Anthropic currently fails on billing, not on this build's own code; re-verify that one path the moment credits are added at console.anthropic.com → Plans & Billing — nothing else about M9 should need to change. Five real bugs were caught and fixed during this verification, not left in — see `DECISIONS.md`. Next: **M10**.
