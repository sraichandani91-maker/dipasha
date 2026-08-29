// Defaults to the relative "/api" path Docker+Caddy (and the Vite dev
// proxy) both split to the API container — see vite-env.d.ts. Set
// VITE_API_BASE_URL at build time when the web build is hosted
// separately from the API (Netlify/Vercel static hosting, no proxy).
const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

// Tokens live in localStorage for now — pragmatic for an internal staff
// tool behind its own auth, revisit with httpOnly cookies + CSRF if this
// ever needs hardening before a wider rollout (see DECISIONS.md).
const ACCESS_KEY = "dipasha_access_token";
const REFRESH_KEY = "dipasha_refresh_token";

export function getTokens() {
  return {
    accessToken: localStorage.getItem(ACCESS_KEY),
    refreshToken: localStorage.getItem(REFRESH_KEY),
  };
}

export function setTokens(accessToken: string, refreshToken?: string) {
  localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

async function request(path: string, opts: RequestInit = {}, retried = false): Promise<any> {
  const { accessToken } = getTokens();
  // Only set a JSON content-type when there's actually a body — sending
  // it on a bodyless POST/DELETE makes Fastify's JSON parser choke on
  // the empty body (FST_ERR_CTP_EMPTY_JSON_BODY).
  const headers: Record<string, string> = { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers as any) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE}${path}`, { ...opts, headers });

  if (res.status === 401 && !retried) {
    const { refreshToken } = getTokens();
    if (refreshToken) {
      const refreshRes = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (refreshRes.ok) {
        const { accessToken: newToken } = await refreshRes.json();
        setTokens(newToken);
        return request(path, opts, true);
      }
    }
    clearTokens();
  }

  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => null) : null;

  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export const api = {
  get: (path: string) => request(path),
  post: (path: string, body?: unknown) => request(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: (path: string, body?: unknown) => request(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: (path: string, body?: unknown) => request(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: (path: string) => request(path, { method: "DELETE" }),
};

export function apiPdfUrl(path: string): string {
  // Label-sheet PDFs are fetched with an auth header then opened as a
  // blob URL by the caller — a plain <a href> can't carry the bearer
  // token.
  return `${BASE}${path}`;
}

// Shared by every M6 report/export download — same auth-header-needs-a-
// blob-fetch reasoning as apiPdfUrl above, generalized past just PDFs.
export async function downloadFile(path: string, filename: string): Promise<void> {
  const { accessToken } = getTokens();
  const res = await fetch(`${BASE}${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// multipart/form-data POST (write-off photo evidence) — deliberately not
// routed through request()'s JSON Content-Type logic; the browser sets
// the correct multipart boundary header itself when given a FormData body.
export async function postForm(path: string, form: FormData): Promise<any> {
  const { accessToken } = getTokens();
  const res = await fetch(`${BASE}${path}`, { method: "POST", body: form, headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}
