// Single source of truth for CORS resolution across all edge functions.
//
// Why this exists: an earlier pattern used `requestOrigin.includes('lovable.app')`
// which incorrectly matched hostile origins like `https://lovable.app.evil.com`.
// This module performs strict hostname-suffix matching so only real Lovable
// preview subdomains (e.g. `<id>.lovableproject.com`, `<id>.lovable.app`) are
// allowed, in addition to an exact-match allowlist of production origins.

const ALLOWED_ORIGINS = [
  "https://theleaseio.com",
  "https://www.theleaseio.com",
  "https://app.theleaseio.com",
  "https://theleaseio.lovable.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];

const ALLOWED_HOST_SUFFIXES = [".lovableproject.com", ".lovable.app", ".vercel.app"];

function parseHost(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function isAllowedOrigin(requestOrigin: string | null): boolean {
  if (!requestOrigin) return false;
  if (ALLOWED_ORIGINS.includes(requestOrigin)) return true;
  const host = parseHost(requestOrigin);
  if (!host) return false;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function resolveAllowedOrigin(requestOrigin: string | null): string {
  return isAllowedOrigin(requestOrigin) ? requestOrigin! : ALLOWED_ORIGINS[0];
}

export function getCorsHeaders(
  requestOrigin: string | null,
  methods: string = "POST, GET, OPTIONS",
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(requestOrigin),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(
  payload: unknown,
  status: number,
  requestOrigin: string | null,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...getCorsHeaders(requestOrigin),
      "Content-Type": "application/json",
    },
  });
}
