/**
 * Resolve where to send a user after a successful login.
 *
 * Priority: the deep link they were bounced off of (ProtectedRoute stashes the
 * full Location object in navigate state as `state.from`) -> an explicit
 * `?next=` query param (AcceptInvite / AcceptFirmInvitation) -> the dashboard.
 * Every candidate is validated as a same-origin absolute path to prevent an
 * open-redirect.
 */
const DEFAULT_REDIRECT = '/app/dashboard';

// Auth pages are never a valid post-login target (would strand/loop the user).
const AUTH_PATHS = new Set(['/login', '/signup']);

type LocationLike = { pathname?: unknown; search?: unknown; hash?: unknown };

/** True only for a single-leading-slash, same-origin path (no protocol-relative / URL / auth page). */
export function isSafeInternalPath(path: string): boolean {
  // Exactly one leading slash: rejects `//evil.com`, `/\evil.com`, `https://...`, `javascript:...`, ''.
  if (!/^\/(?![/\\])/.test(path)) return false;
  const pathname = path.split(/[?#]/)[0];
  return !AUTH_PATHS.has(pathname);
}

/** Normalize `state.from` (a Location object or a raw string) to a path string. */
function toPath(from: unknown): string | null {
  if (typeof from === 'string') return from;
  if (from && typeof from === 'object') {
    const { pathname, search, hash } = from as LocationLike;
    if (typeof pathname === 'string' && pathname.length > 0) {
      return `${pathname}${typeof search === 'string' ? search : ''}${typeof hash === 'string' ? hash : ''}`;
    }
  }
  return null;
}

export function resolvePostLoginRedirect(from: unknown, nextParam: string | null | undefined): string {
  for (const candidate of [toPath(from), nextParam ?? null]) {
    if (candidate && isSafeInternalPath(candidate)) return candidate;
  }
  return DEFAULT_REDIRECT;
}
