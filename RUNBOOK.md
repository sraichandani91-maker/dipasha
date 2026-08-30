# Runbook — deploying and operating Dipasha OS

Written so you can deploy this without me.

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

## Testing the web console on Netlify/Vercel (frontend only)

`apps/web` is a static Vite build and can be hosted on Netlify or Vercel for quick, shareable-link testing without provisioning a VPS. `apps/api` **cannot** — it's a long-running Fastify server with a persistent Postgres connection pool and several always-on background jobs (the WhatsApp dispatcher retry loop, the daily report generator, chronic-refill reminders), none of which survive on stateless serverless/edge functions. The API still needs a real host with a real Postgres — the VPS/Docker setup above, or any other host that runs a persistent Node process (Railway, Render, Fly.io are all faster to stand up than a VPS if you just want something to test against).

Once the API is running somewhere reachable over HTTPS:

1. **Netlify** — `netlify.toml` at the repo root already sets the build command (`npm ci && npm run build --workspace apps/web`, run from the repo root because `apps/web` depends on `packages/theme` via npm workspaces — a "Base directory" of `apps/web` alone can't resolve that) and publish directory (`apps/web/dist`). In the Netlify UI, set the environment variable `VITE_API_BASE_URL` to the API's origin (e.g. `https://api.yourdomain.com`, no trailing slash, no `/api` suffix).
2. **Vercel** — `vercel.json` at the repo root does the same. Set `VITE_API_BASE_URL` under Project Settings → Environment Variables.
3. **On the API itself**, set `CORS_ORIGINS` to the Netlify/Vercel URL(s) (comma-separated) once you know them — it defaults to allowing any origin, which is fine for a first test but should be tightened once the real frontend URL is known.

Leaving `VITE_API_BASE_URL` unset keeps the existing behavior (a relative `/api` path) exactly as it is for local dev and the Docker+Caddy setup — this is purely additive.

## Testing the whole app on Render

Unlike Netlify/Vercel, Render can host **all of it** — `apps/api` runs as a real, always-on service (its persistent Postgres pool and background jobs work here, since it's not serverless), with a managed Postgres and `apps/web` as a static site alongside it. `render.yaml` at the repo root defines all three as one Blueprint.

1. In the Render dashboard: **New → Blueprint**, point it at this repo/branch. It reads `render.yaml` and proposes a Postgres database (`dipasha-postgres`), the API as a Docker web service (`dipasha-api`, built from `apps/api/Dockerfile`), and the console as a static site (`dipasha-web`). Apply it.
2. **Run migrations once** — same "never automatic" rule as `deploy.sh`. Two ways to do this:
   - **By hand**: once `dipasha-api` has deployed, open its **Shell** tab in the Render dashboard and run:
     ```
     npm run migrate:up --workspace apps/api
     npm run seed --workspace apps/api   # optional — loads the same 50-item demo data as local dev
     ```
   - **Without opening the dashboard's Shell tab**: set the env vars `RUN_MIGRATE_ON_BOOT=true` and (optionally) `RUN_SEED_ON_BOOT=true` on `dipasha-api` — changing env vars triggers Render's own redeploy automatically. `apps/api/docker-entrypoint.sh` runs the migration (and seed, if flagged) once before starting the server, then boots normally. **Set both back to `false` afterward** — otherwise every future restart re-runs them (harmless — both are idempotent, `migrate:up` skips applied migrations and `seed` refuses to run against a non-empty `products` table — but pointless work on every deploy).
3. **Update the two placeholder URLs** — `render.yaml` guesses both services' URLs before Render has actually assigned them (a service name can get a random suffix if it's taken). After the first deploy, check the real URLs in the dashboard and, if they differ from the guess:
   - Set `dipasha-web`'s `VITE_API_BASE_URL` env var to the real `dipasha-api` URL, then manually redeploy `dipasha-web` (env vars only take effect on the next build for a static site).
   - Set `dipasha-api`'s `CORS_ORIGINS` env var to the real `dipasha-web` URL (tightening it from the wide-open default), then it picks that up on its next restart.
4. Open the `dipasha-web` URL and log in with the seeded username/password pairs below (same as local dev).

Two honest limitations of testing here, not bugs: Render's **free Postgres is deleted after 90 days** — fine for a trial, not for anything you want to keep; and the API's **free-tier disk is ephemeral**, so write-off photo evidence uploaded there won't survive a redeploy (the Docker+Caddy VPS setup uses a named volume for this instead — see `docker-compose.yml`).

## Local development (no Docker required for the API or console)

The fastest way to see the whole app working — nothing to deploy, no hosting account, full backend + database + UI — is to run it right here on your own machine.

**Prerequisites**: Node 20+, and either Docker (for Postgres only — easiest) or a local Postgres 16 install.

```
git clone <repo-url> && cd dipasha
npm install

cp .env.example .env
# Edit .env and set two things:
#   DATABASE_URL=postgres://dipasha:change-me@localhost:5432/dipasha   (matches the Postgres vars above)
#   JWT_SECRET=<any random string>    (e.g. output of: openssl rand -hex 32)

docker compose up -d postgres        # or point DATABASE_URL at a Postgres you already have running

npm run migrate:up --workspace apps/api
npm run seed --workspace apps/api    # loads 50 demo medicines, bins, batches, and 4 test logins — skip this and every screen is empty

npm run dev:api                      # terminal 1 — API on :3000
npm run dev --workspace apps/web     # terminal 2 — console on :5173, proxies /api to :3000
```

Open http://localhost:5173. Log in with any of the seeded username/password pairs (username + password login, not phone + OTP — see below):

| Role | Username | Password |
|---|---|---|
| Owner | `owner` | `dipasha123` |
| Store Manager | `manager` | `dipasha123` |
| Picker/packer | `picker` | `dipasha123` |
| Rider | `rider` | `dipasha123` |

The Owner login sees everything — Home dashboard, POS billing, Order book, Reports, Settings, Staff, Activity logs. The other three see only what that role is meant to see, which is itself worth clicking through to see the role-based access actually working.

## Day-to-day operations

- Logs: `docker compose logs -f api` (or `web`, `caddy`)
- Restart: `docker compose restart api` (or `web`)
- Shell into the API container: `docker compose exec api sh`
- Run a migration by hand: `docker compose exec api npm run migrate:up --workspace apps/api`
- Roll back the last migration: `docker compose exec api npm run migrate:down --workspace apps/api`

## Backups (Section 12B.3 — "treat as the highest priority item")

`scripts/backup.sh` dumps Postgres (via `pg_dump "$DATABASE_URL"` — this is why the Postgres port stays bound to `127.0.0.1:5432` in `docker-compose.yml` even in production, so a host-level cron job can reach it) and archives the uploads directory (prescription/write-off/expense photos), both gzipped into `./backups` with a UTC timestamp, and prunes anything older than `BACKUP_RETENTION_DAYS` (default 30).

Run it daily via cron:
```
crontab -e
# add:
0 2 * * * cd /path/to/dipasha && ./scripts/backup.sh >> /var/log/dipasha-backup.log 2>&1
```

**Off-server storage.** No object storage account exists yet (Section 14 — yours to buy). Once you have one, install `rclone` (`apt install rclone`), run `rclone config` once to point it at your provider, and set `BACKUP_RCLONE_REMOTE=remotename:bucket/path` in `.env` — `backup.sh` picks it up automatically on the next run. Until then, every run prints a loud warning that backups are sitting on the same disk as the data they protect, which is real risk, not a formality — the VPS itself is the single point of failure until this is set.

**A backup that's never been restored is not a backup.** Test it now, and periodically after:
```
./scripts/restore.sh backups/dipasha-db-<timestamp>.sql.gz backups/dipasha-uploads-<timestamp>.tar.gz
```
This restores into a throwaway `dipasha_restore_test` database (never the live one — safe to run on production), checks the `settings` table actually has rows, and extracts the uploads archive into `./uploads-restore-test` without touching the real uploads directory. Drop the test database when done (the script prints the exact command). Time the whole thing at least once and write the duration down somewhere you'll find it during a real incident.

**One-time prerequisite on the VPS**: `apt install postgresql-client` (for `pg_dump`/`psql` — Postgres itself stays in Docker; only the client tools need to be on the host).

## Uptime + backup-freshness monitoring (Section 12B.3–12B.4)

Two more cron scripts, both alerting over WhatsApp (falls back to a log line if `WHATSAPP_ALERT_PHONE` or real Meta Cloud API credentials aren't set yet — same honest-fallback story as every other unconfigured integration in this build):

```
crontab -e
# add:
*/5 * * * * cd /path/to/dipasha && ./scripts/uptime-check.sh >> /var/log/dipasha-uptime.log 2>&1
0 9 * * 1   cd /path/to/dipasha && ./scripts/backup-freshness-check.sh >> /var/log/dipasha-backup-check.log 2>&1
```

`uptime-check.sh` hits `/api/health` and alerts only on a state *change* (down, then recovered) — not on every failed tick, or a real outage would flood you with a message every 5 minutes for as long as it lasts. `backup-freshness-check.sh` runs weekly and alerts if the latest backup is missing, zero-byte, or older than `BACKUP_FRESHNESS_MAX_AGE_HOURS` (default 48h) — this is what actually catches "the daily backup cron silently stopped running three weeks ago," which `backup.sh` succeeding on the day it succeeds can never catch on its own.

Set `WHATSAPP_ALERT_PHONE` and, once you have a real WhatsApp Business Cloud API account (Section 14), `WHATSAPP_CLOUD_API_TOKEN` + `WHATSAPP_CLOUD_API_PHONE_NUMBER_ID` in `.env`.

## Error tracking (Section 12B.4)

Sign up at sentry.io (or self-host GlitchTip, which speaks the same protocol), create two projects (Node for the API, React for the web console), and set `SENTRY_DSN` (API) and `VITE_SENTRY_DSN` (web) in `.env`. The web console's DSN is baked into the static bundle at `docker compose build` time, not read at container startup — changing it needs a rebuild (`./deploy.sh` already does this on every deploy). Leave both unset and error tracking is a complete no-op; nothing breaks, you just won't be alerted to a crash until someone tells you about it.
