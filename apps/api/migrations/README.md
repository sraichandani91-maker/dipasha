# Migrations

Managed with [node-pg-migrate](https://github.com/salsita/node-pg-migrate). Plain SQL/JS migration files, applied explicitly — never automatically on application boot (per the ground rules: migrations run as a deliberate, reversible deploy step).

The first real migration — the movement ledger and the rest of the M1 data model — is created in Milestone 1. This directory is intentionally empty at M0.

Usage (from repo root):

```
npm run migrate --workspace apps/api -- create add_some_table
npm run migrate:up --workspace apps/api
npm run migrate:down --workspace apps/api
```

Requires `DATABASE_URL` in the environment (see `.env.example`).
