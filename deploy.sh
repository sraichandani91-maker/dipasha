#!/usr/bin/env bash
# Deploy the current branch to this host. Run from the repo root on the VPS.
# See RUNBOOK.md for first-time setup (DNS, .env, Docker install).
set -euo pipefail

if [ ! -f .env ]; then
  echo "Missing .env — copy .env.example to .env and fill it in first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "==> Pulling latest code"
git pull --ff-only

# Section 12B.4: every Sentry event is tagged with the deploy it came
# from, so a bug report reads "this started at commit abc1234," not just
# a timestamp. No effect at all if SENTRY_DSN isn't set.
export RELEASE_VERSION
RELEASE_VERSION="$(git rev-parse --short HEAD)"

echo "==> Building images"
docker compose build

echo "==> Running database migrations (explicit step, never automatic)"
docker compose run --rm --no-deps \
  -e DATABASE_URL="postgres://${POSTGRES_USER:-dipasha}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-dipasha}" \
  api npm run migrate:up --workspace apps/api

echo "==> Starting services (api, postgres, and caddy if this host serves traffic)"
docker compose --profile proxy up -d --remove-orphans

echo "==> Waiting for /health"
for i in $(seq 1 30); do
  if docker compose exec -T api node -e \
      "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    echo "Healthy."
    exit 0
  fi
  sleep 1
done

echo "api did not report healthy within 30s — check: docker compose logs api" >&2
exit 1
