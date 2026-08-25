const BASE = "/api";

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
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as any) };
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
  patch: (path: string, body?: unknown) => request(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
};

export function apiPdfUrl(path: string): string {
  // Label-sheet PDFs are fetched with an auth header then opened as a
  // blob URL by the caller — a plain <a href> can't carry the bearer
  // token.
  return `${BASE}${path}`;
}
