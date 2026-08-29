/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Section 12B.4 — see src/lib/error-tracking.ts. Both optional: unset
  // means error tracking is a no-op, the supported default state until a
  // real Sentry project exists (Section 14).
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_RELEASE_VERSION?: string;
  // Only needed when the web build and the API aren't served from the
  // same origin behind one reverse proxy (Docker+Caddy's "/api/* to the
  // api container" split — see infra/Caddyfile). A static host like
  // Netlify/Vercel has no such proxy, so this points the built app at
  // wherever the API actually runs, e.g. "https://api.yourdomain.com".
  // Unset (the Docker/local-dev default) keeps the existing relative
  // "/api" path unchanged.
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
