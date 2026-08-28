import * as Sentry from "@sentry/node";
import { config } from "../config.js";

/**
 * Section 12B.4: "Error tracking (Sentry or equivalent) with alerts, so
 * silent failures do not accumulate unnoticed." No Sentry project exists
 * yet (Section 14 — the account is the owner's to create); this
 * initializes the real SDK when `SENTRY_DSN` is set and is a deliberate,
 * total no-op otherwise — every function below is safe to call
 * unconditionally from anywhere in the app without an `if (config.sentryDsn)`
 * guard at every call site.
 */
export function initErrorTracking(): void {
  if (!config.sentryDsn) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    release: config.releaseVersion,
    tracesSampleRate: 0,
  });
}

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (!config.sentryDsn) return;
  Sentry.captureException(err, extra ? { extra } : undefined);
}

// Called before process exit on an uncaught exception / unhandled
// rejection — Sentry's own docs warn its default async transport can
// lose the event if the process exits immediately after `captureException`,
// so this explicitly waits (bounded) for the flush before index.ts exits.
export async function flushErrorTracking(timeoutMs = 2000): Promise<void> {
  if (!config.sentryDsn) return;
  await Sentry.flush(timeoutMs);
}
