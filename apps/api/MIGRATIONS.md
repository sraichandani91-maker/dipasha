# Migrations

Managed with [node-pg-migrate](https://github.com/salsita/node-pg-migrate). Plain SQL/JS migration files, applied explicitly — never automatically on application boot (per the ground rules: migrations run as a deliberate, reversible deploy step).

M1 added the first real migrations: settings, users/auth, salt and product master, bin master, batches, and the movement ledger (with its append-only trigger and the `stock` view).

Note: this file lives at `apps/api/MIGRATIONS.md`, not inside `migrations/` — node-pg-migrate scans every file in that directory as a candidate migration, so nothing non-migration belongs there.

Usage (from repo root):

```
npm run migrate --workspace apps/api -- create add_some_table   # writes into apps/api/migrations/
npm run migrate:up --workspace apps/api
npm run migrate:down --workspace apps/api
```

Requires `DATABASE_URL` in the environment (see `.env.example`).
