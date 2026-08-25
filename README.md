# Dipasha Medical Store — operations platform

Backend + web console + (later) Android staff app for a retail pharmacy running a quick-commerce style delivery pilot out of Prayagraj. Single store, single warehouse, multi-store-ready schema. Full spec lives outside this repo (the build prompt); this README covers what's actually built.

Built milestone by milestone per the agreed build order — see `DECISIONS.md` for what's been decided at each step, and don't skip ahead of the current milestone.

## Status: M0 — deployable skeleton

What exists right now:
- `apps/api` — Fastify + TypeScript API with a `/health` endpoint (checks DB connectivity when configured)
- `packages/theme` — shared design tokens (currently **placeholder** colours — see `packages/theme/README.md`)
- Docker Compose: Postgres + API + Caddy (automatic HTTPS reverse proxy)
- CI: typecheck, build, and a Docker smoke test on every push
- `deploy.sh` + `RUNBOOK.md`: how to actually get this running on a VPS

Not built yet: any business logic, data model, auth, or UI. That starts at M1.

## Repo layout

```
apps/
  api/            Fastify backend
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
cp .env.example .env
docker compose up -d postgres
npm install
npm run dev:api
curl http://localhost:3000/health
```

## Full stack via Docker

```
cp .env.example .env   # set POSTGRES_PASSWORD at minimum
docker compose up -d --build
curl http://localhost:3000/health
```

See `RUNBOOK.md` for deploying to a real VPS with HTTPS on a subdomain.

## Build order

Milestones M0–M16 as agreed. Each one gets built, tested by the owner, then the next starts — no skipping ahead, no scope creep beyond what's specified. Current milestone: **M0**, done pending your sign-off. Next: **M1** — data model (movement ledger, all `movement_type` values), migrations, auth, role framework, seeded with 50 dummy SKUs.
