# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M1 — data model, migrations, auth, role framework

What exists right now:
- `apps/api` — Fastify + TypeScript API: `/health`, phone+OTP login, JWT access/refresh, PIN idle-lock re-auth, owner impersonation, and a role-gated `/products` endpoint (see `apps/api/MIGRATIONS.md` and `DECISIONS.md`)
- Full M1 schema: settings, users/roles, salt master, product master + composition child table, bin master, batches, and the append-only movement ledger (all 9 `movement_type` values, DB-trigger-enforced immutability, on-hand stock as a derived `VIEW`, never a stored column)
- Seed script: 4 role users, 25 salts, 50 dummy SKUs (auto-grouped into real substitute groups), 59 bins across every zone prefix, batches with opening stock
- `packages/theme` — shared design tokens (estimated from the real logo/site screenshot — see `packages/theme/README.md`)
- Docker Compose: Postgres + API + Caddy (automatic HTTPS reverse proxy)
- CI: typecheck, build, and a Docker smoke test on every push
- `deploy.sh` + `RUNBOOK.md`: how to actually get this running on a VPS

No UI yet — M1 is backend only. First screens arrive at M2 (bin labels, unified search) and M4 (POS).

## Repo layout

```
apps/
  api/            Fastify backend
    migrations/   node-pg-migrate files (schema, in order)
    scripts/seed.ts  Dev seed data — 50 SKUs, bins, batches, opening stock
    src/domain/   Business rules shared across routes/seed (e.g. substitute grouping)
    MIGRATIONS.md How the migration/seed workflow works
packages/
  theme/          Shared design tokens (colors, spacing) — web + app both import this
infra/
  Caddyfile       Reverse proxy config (templated with $DOMAIN)
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
npm run dev:api
curl http://localhost:3000/health
```

Log in as the seeded owner: `POST /auth/otp/request {"phone":"+919999900001"}` — in development the response includes `devCode` (no real SMS provider is wired up yet), then `POST /auth/otp/verify {"phone":"+919999900001","code":"<devCode>"}` for a JWT. PIN for all seeded users is `1234`.

## Full stack via Docker

```
cp .env.example .env   # set POSTGRES_PASSWORD and JWT_SECRET at minimum
docker compose up -d --build
docker compose exec api npm run migrate:up --workspace apps/api
curl http://localhost:3000/health
```

See `RUNBOOK.md` for deploying to a real VPS with HTTPS on a subdomain.

## Build order

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M1**, done pending sign-off. Next: **M2** — product master + bin master + label printing, product creation with the salt master, and the unified search of Section 5B.
