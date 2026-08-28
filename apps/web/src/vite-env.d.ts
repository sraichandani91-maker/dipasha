/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Section 12B.4 — see src/lib/error-tracking.ts. Both optional: unset
  // means error tracking is a no-op, the supported default state until a
  // real Sentry project exists (Section 14).
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_RELEASE_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
