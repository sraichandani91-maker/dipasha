#!/bin/sh
# Opt-in, off-by-default boot hooks for one-off environments (e.g. a fresh
# Render deploy) where nobody has shell access to run migrations/seed by
# hand. Setting these env vars is still an explicit action — same "never
# automatic" rule as deploy.sh — it's just a redeploy instead of a shell
# command. Leave both unset and this does exactly what CMD always did.
set -e

if [ "$RUN_MIGRATE_ON_BOOT" = "true" ]; then
  echo "[entrypoint] RUN_MIGRATE_ON_BOOT=true — running pending migrations..."
  npm run migrate:up --workspace apps/api
fi

if [ "$RUN_SEED_ON_BOOT" = "true" ]; then
  echo "[entrypoint] RUN_SEED_ON_BOOT=true — running seed script..."
  npm run seed --workspace apps/api
fi

exec node apps/api/dist/index.js
