# Runbook — deploying and operating Dipasha OS

Written so you can deploy this without me. Backup/restore and monitoring are built out properly in M16 — everything below is the minimum to get the API and web console reachable over HTTPS on one subdomain.

## What you're responsible for (Section 14)

- Buying the VPS
- A managed Postgres instance, or running Postgres on the same VPS (either works; this repo defaults to running it in Docker alongside the API)
- Pointing a subdomain (e.g. `app.dipashamedicalstore.in`) at the VPS's public IP — an A record, DNS only, no proxy/CDN in front (Caddy needs to see real HTTP traffic on 80/443 to issue its own Let's Encrypt certificate)

## One-time VPS setup

1. Ubuntu LTS VPS, 2 vCPU / 4 GB is plenty for one store.
2. Install Docker + Compose plugin:
   ```
   curl -fsSL https://get.docker.com | sh
   ```
3. Point DNS: an A record for your chosen subdomain → the VPS's public IP. Wait for it to propagate (`dig app.yourdomain.in`).
4. Clone this repo onto the VPS:
   ```
   git clone <repo-url> dipasha && cd dipasha
   ```
5. Copy `.env.example` to `.env` and fill in real values — a strong `POSTGRES_PASSWORD`, and `DOMAIN` set to the subdomain from step 3.
6. Open ports 80 and 443 on the VPS firewall (needed for Caddy's ACME challenge and for serving traffic). Leave everything else closed — Postgres is bound to localhost only in `docker-compose.yml` and must never be reachable from outside this host.

## Deploying

```
./deploy.sh
```

This pulls the latest commit on the current branch, builds the API and web images, runs pending migrations explicitly, brings up `postgres`, `api`, `web`, and `caddy` (the `proxy` profile), and waits for `/health` to report healthy.

Caddy requests and auto-renews its own TLS certificate from Let's Encrypt on first boot — no manual certbot steps. It splits the subdomain by path: `/api/*` goes to the api container, everything else to the web console (`infra/Caddyfile`).

Verify:
```
curl https://app.yourdomain.in/api/health   # api
curl https://app.yourdomain.in/             # web console
```
The health check should return `{"status":"ok", ...}`.

## Staging vs production

Run staging as a second, independent Compose stack on the same box (or a smaller second VPS):

```
git clone <repo-url> dipasha-staging && cd dipasha-staging
git checkout staging   # or whatever branch you use for staging
cp .env.example .env   # different POSTGRES_PASSWORD, different DOMAIN (e.g. staging.yourdomain.in)
./deploy.sh
```

Because `docker-compose.yml` uses the default project name `dipasha`, give the staging checkout its own directory (as above) so Docker doesn't collide the two stacks' volumes and networks. Never test a migration against production data first — always run it on staging.

## Local development (no Docker required for the API or console)

```
cp .env.example .env          # set DATABASE_URL to point at a local Postgres, or use Docker for just Postgres:
docker compose up -d postgres
npm install
npm run migrate:up --workspace apps/api
npm run dev:api                     # terminal 1 — API on :3000
npm run dev --workspace apps/web    # terminal 2 — console on :5173, proxies /api to :3000
```

Open http://localhost:5173.

## Day-to-day operations

- Logs: `docker compose logs -f api` (or `web`, `caddy`)
- Restart: `docker compose restart api` (or `web`)
- Shell into the API container: `docker compose exec api sh`
- Run a migration by hand: `docker compose exec api npm run migrate:up --workspace apps/api`
- Roll back the last migration: `docker compose exec api npm run migrate:down --workspace apps/api`

## What's deliberately not here yet

Automated backups, restore testing, uptime alerting to WhatsApp, and error tracking are Milestone 16 (Section 12B.3–12B.4). Until then, treat this VPS's Postgres volume as **not backed up** — don't put real shop data on it before M16, or take a manual `docker compose exec postgres pg_dump` before anything you'd be upset to lose.
