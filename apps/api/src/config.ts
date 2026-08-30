export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? "",

  // Only matters when the web build is hosted on a different origin
  // than the API — the Docker+Caddy setup and local dev both put the
  // API behind the same origin (via a reverse proxy), where CORS is a
  // no-op either way. Comma-separated allow-list, e.g.
  // "https://app.yourdomain.com,https://staging.yourdomain.com".
  // Defaults to "*" (any origin) — safe here because auth is a bearer
  // token read from localStorage and sent via an Authorization header,
  // never a cookie, so there's no ambient-credential CSRF surface a
  // wildcard origin would open up. Tighten this once real domains exist.
  corsOrigins: process.env.CORS_ORIGINS ?? "*",

  // Auth (Section 3, Section 12) — username + password, JWT access/refresh.
  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtAccessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 15 * 60),
  jwtRefreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 30 * 24 * 60 * 60),

  // WhatsApp bill send (Section 6A.6 / Section 14). Same story as OTP
  // delivery above — no real provider account exists yet, so this is a
  // pluggable interface (`lib/whatsapp-sender.ts`) with a dev console
  // sender for now. "console" is the only value this build understands
  // until real provider credentials are added.
  whatsappProvider: process.env.WHATSAPP_PROVIDER ?? "console",

  // Local disk (Section 9's write-off photo evidence). No object storage
  // (S3/GCS) is configured for this pilot's single-VPS deployment — see
  // DECISIONS.md. Move this to real object storage before running more
  // than one API instance, since local disk won't survive a redeploy.
  uploadDir: process.env.UPLOAD_DIR ?? "./uploads",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024),

  // M16 / Section 12B.4 error tracking. No Sentry (or equivalent) project
  // exists yet — that account is the owner's to create, same "real
  // provider, pluggable interface, honest no-op until credentialed" story
  // as WhatsApp/OTP above. `lib/error-tracking.ts` no-ops entirely when
  // this is unset, so leaving it blank is a safe, supported state, not a
  // half-finished one.
  sentryDsn: process.env.SENTRY_DSN ?? "",
  releaseVersion: process.env.RELEASE_VERSION ?? "dev",
};
