export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: process.env.DATABASE_URL ?? "",

  // Auth (Section 3, Section 12). No real SMS/WhatsApp provider is wired
  // up yet (Section 14 — that's the owner's account to set up, M8) so OTP
  // delivery is a pluggable interface with a dev console sender for now.
  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtAccessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 15 * 60),
  jwtRefreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 30 * 24 * 60 * 60),
  otpTtlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 5 * 60),
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),

  // Local disk (Section 9's write-off photo evidence). No object storage
  // (S3/GCS) is configured for this pilot's single-VPS deployment — see
  // DECISIONS.md. Move this to real object storage before running more
  // than one API instance, since local disk won't survive a redeploy.
  uploadDir: process.env.UPLOAD_DIR ?? "./uploads",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024),
};
