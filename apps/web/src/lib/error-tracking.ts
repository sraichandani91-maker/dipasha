import * as Sentry from "@sentry/react";

/**
 * Section 12B.4's error tracking, web-console side — same story as
 * `apps/api/src/lib/error-tracking.ts`: a total no-op until a real
 * Sentry DSN exists (Section 14 — the account is the owner's to create).
 * `VITE_SENTRY_DSN` is inlined into the static build at `docker build`
 * time (Vite env vars, not read at container runtime — see
 * apps/web/Dockerfile), so it has to be set before the image is built,
 * not just before it's started.
 */
export function initErrorTracking(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE_VERSION || "dev",
    tracesSampleRate: 0,
  });
}

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  Sentry.captureException(err, extra ? { extra } : undefined);
}
