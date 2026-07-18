import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #174/#169 — data-router migration + shared unsaved-changes guard.
// Static pins (repo readFileSync + narrowed-window convention):
//   (1) App.tsx runs on createBrowserRouter/<RouterProvider> (useBlocker
//       throws outside a data router), and the pathless RootLayout preserves
//       the Suspense fallback + ErrorBoundary parity (data routers intercept
//       route render errors before main.tsx's boundary).
//   (2) the hook's contract: useBlocker + native confirm via the i18n key,
//       same-pathname early return (?tab= flows must not prompt), the
//       beforeunload twin, and the canceled-block reset.
//   (3) single-blocker discipline: react-router consults only the LAST
//       registered blocker, so exactly ONE guard instance may exist per page
//       — pages own the guard, children lift dirty flags into it, and nobody
//       outside the hook file touches useBlocker.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#174 — App.tsx runs on the data router', () => {
  const app = read('src/App.tsx');

  it('uses createBrowserRouter + <RouterProvider>, not <BrowserRouter>', () => {
    expect(app).toContain('createBrowserRouter');
    expect(app).toContain('<RouterProvider');
    expect(app).not.toContain('<BrowserRouter>');
  });

  it('RootLayout preserves ErrorBoundary + Suspense parity above the Outlet', () => {
    const start = app.indexOf('function RootLayout');
    const end = app.indexOf('const router');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = app.slice(start, end);
    expect(block).toContain('<ErrorBoundary>');
    expect(block).toContain('<Suspense');
    expect(block).toContain('<Outlet />');
  });
});

describe('#169 — shared guard hook contract', () => {
  const hook = read('src/hooks/useUnsavedChangesGuard.ts');

  it('blocks via useBlocker + native confirm with the i18n key', () => {
    expect(hook).toContain('useBlocker');
    expect(hook).toContain("t('common.unsaved_nav_confirm')");
  });

  it('ignores same-pathname navigations (?tab= / hash-only)', () => {
    expect(hook).toContain('currentLocation.pathname === nextLocation.pathname');
  });

  it('owns the beforeunload twin and resets canceled blocks', () => {
    expect(hook).toContain("addEventListener('beforeunload'");
    expect(hook).toContain('blocker.reset()');
  });

  it('the confirm copy exists in both locale files', () => {
    const en = JSON.parse(read('src/locales/en/common.json'));
    const es = JSON.parse(read('src/locales/es/common.json'));
    expect(typeof en.common.unsaved_nav_confirm).toBe('string');
    expect(typeof es.common.unsaved_nav_confirm).toBe('string');
  });
});

describe('#174 — single-blocker discipline (one guard per page)', () => {
  it('LeaseReview owns the single guard (form + lifted ASC dirty), no hand-rolled beforeunload', () => {
    const src = read('src/pages/app/LeaseReview.tsx');
    expect(src).toContain('useUnsavedChangesGuard(');
    expect(src).toContain('ascDirty');
    expect(src).toContain('isSameLeaseSurface');
    expect(src).not.toContain("addEventListener('beforeunload'");
    expect(src).not.toContain('useBlocker');
  });

  it('Asc842InputsTab lifts dirty via onDirtyChange instead of blocking itself', () => {
    const src = read('src/components/leases/Asc842InputsTab.tsx');
    expect(src).toContain('onDirtyChange');
    // Unmount must clear the page flag (locked↔unlocked branch flips).
    expect(src).toContain('onDirtyChange?.(false)');
    expect(src).not.toContain('useBlocker');
    expect(src).not.toContain("addEventListener('beforeunload'");
  });

  it('LockedLeaseDetail forwards the ASC dirty flag to the host page', () => {
    const src = read('src/components/leases/locked/LockedLeaseDetail.tsx');
    expect(src).toContain('onAscDirtyChange');
    expect(src).toContain('onDirtyChange={onAscDirtyChange}');
    expect(src).not.toContain('useBlocker');
  });

  it('ApprovalPolicyEditPage gained snapshot dirty tracking + guard + post-save bypass', () => {
    const src = read('src/pages/settings/ApprovalPolicyEditPage.tsx');
    expect(src).toContain('useUnsavedChangesGuard(');
    expect(src).toContain('serializePolicy');
    expect(src).toContain('bypass();');
    expect(src).not.toContain('useBlocker');
  });
});
