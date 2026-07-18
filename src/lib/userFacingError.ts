// #173 — user-facing error mapping.
//
// Raw Postgrest/trigger/driver text ("new row violates row-level security
// policy…", "Cannot modify a locked lease…") must never reach the UI: it is
// unlocalized, jargon-heavy, and leaks schema detail. This helper maps the
// three recognizable classes to localized copy and falls back to the caller's
// surface-specific localized key for everything else. The raw error is ALWAYS
// preserved in the console (the helper owns the console.error, so call sites
// drop their local ones — pass logContext to keep the prior log label).

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function mapSupabaseError(
  err: unknown,
  t: Translate,
  fallbackKey: string,
  logContext = '[mapSupabaseError]',
): string {
  // eslint-disable-next-line no-console
  console.error(logContext, err);
  const anyErr = err as { message?: unknown; code?: unknown } | null | undefined;
  const raw = String(anyErr?.message ?? err ?? '');
  // Lease-lock governance trigger (baseline migration: "Cannot modify a
  // locked lease except through the governance workflow").
  if (/locked lease|governance workflow/i.test(raw)) {
    return t('errors.lease_locked');
  }
  // RLS / permission denials. Deliberately NOT a bare "violates" match —
  // check-constraint violations are not permission problems.
  if (anyErr?.code === '42501' || /row-level security|permission denied/i.test(raw)) {
    return t('errors.no_permission');
  }
  // Network-level failures (supabase-js throws "Failed to fetch"-class
  // errors when offline/unreachable).
  if (/failed to fetch|network ?error|fetch ?error/i.test(raw)) {
    return t('errors.network');
  }
  return t(fallbackKey);
}
