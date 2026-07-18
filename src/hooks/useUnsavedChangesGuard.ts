import { useCallback, useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface Options {
  /** Return true when a pathname change stays on the same mounted surface
   *  (e.g. /app/leases/:id ↔ /app/leases/:id/review) — never blocked. */
  isSameSurface?: (currentPathname: string, nextPathname: string) => boolean;
}

/** #174/#169 — one guard per page (react-router supports a single active
 *  blocker; child components lift their dirty flags to the page's instance).
 *  Covers SPA navigation (useBlocker + native confirm) AND hard navigation
 *  (beforeunload) from the same `when` signal. */
export function useUnsavedChangesGuard(when: boolean, options?: Options) {
  const { t } = useAppTranslation();
  const bypassRef = useRef(false);
  const isSameSurface = options?.isSameSurface;

  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) => {
        // Consume the one-shot FIRST, unconditionally — before the `when` and
        // same-pathname checks. Otherwise a bypass() armed while clean (or
        // eaten by a benign ?tab= navigation) survives and silently waves
        // through a later, real navigation (auditor MEDIUM 2026-07-18).
        if (bypassRef.current) { bypassRef.current = false; return false; }
        if (!when) return false;
        if (currentLocation.pathname === nextLocation.pathname) return false; // ?tab= / hash only
        if (isSameSurface?.(currentLocation.pathname, nextLocation.pathname)) return false;
        return !window.confirm(t('common.unsaved_nav_confirm'));
      },
      [when, isSameSurface, t],
    ),
  );

  // A canceled navigation leaves the blocker 'blocked'; reset so the next
  // attempt re-evaluates cleanly (documented usePrompt pattern).
  useEffect(() => {
    if (blocker.state === 'blocked') blocker.reset();
  }, [blocker]);

  // A bypass armed for a navigation that never happened must not linger into
  // the next dirty session.
  useEffect(() => {
    if (!when) bypassRef.current = false;
  }, [when]);

  useEffect(() => {
    if (!when) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [when]);

  /** Skip the guard for the NEXT navigation only — call immediately before a
   *  known-safe programmatic navigate() (e.g. right after a successful save). */
  const bypass = useCallback(() => { bypassRef.current = true; }, []);
  return { bypass };
}
