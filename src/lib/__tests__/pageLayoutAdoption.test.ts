import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// FS-3 layout-system pin (Wave 1 / Wave 1b).
//
// Every app page that renders the full-width sticky <AppHeader> must render
// its body through <PageLayout> (src/components/layout/PageLayout.tsx), so the
// content column keeps a consistent, bounded width as the user walks the nav.
// Before the layout system, each page hand-rolled its own container
// (max-w-2xl / -5xl / -6xl mx-auto, or full-bleed p-6) and the column jumped
// width page to page. This pin fails when a NEW page reintroduces that drift —
// imports AppHeader but not PageLayout — which is exactly how the mess started.
//
// ALLOWLIST is the shrinking set of pages not yet migrated (or intentionally
// exempt). It is expected to SHRINK over time: when you migrate an allowlisted
// page, delete its entry here — the stale-entry test below fails if a migrated
// (or deleted) page is still listed. Do NOT grow this list to silence the pin;
// migrate the page instead, or add an entry with a real, documented reason.
const ALLOWLIST: Record<string, string> = {
  'src/pages/app/LeaseReview.tsx':
    'full-bleed split-pane review workbench (PDF + panel) — not a bounded content column',
  'src/pages/app/ExtractionAnalytics.tsx': 'dev-only analytics page',
  'src/pages/app/NotificationDetail.tsx': 'not yet migrated',
  'src/pages/app/OperationsPage.tsx': 'not yet migrated',
  'src/pages/app/Support.tsx': 'not yet migrated',
  'src/pages/settings/AccountSettings.tsx': 'not yet migrated',
  'src/pages/settings/WorkspacesSection.tsx':
    'renders its own AppHeader as a settings sub-section — not yet migrated',
  'src/pages/settings/ApprovalPoliciesListPage.tsx':
    'deferred — full rewrite in flight on branch approval-simplify; migrate with that rework',
  'src/pages/settings/ApprovalPolicyEditPage.tsx':
    'deferred — full rewrite in flight on branch approval-simplify; migrate with that rework',
};

const repoRoot = join(__dirname, '..', '..', '..');

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkTsx(full, out);
    } else if (name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const rel = (full: string) => full.slice(repoRoot.length + 1).replace(/\\/g, '/');

const importsAppHeader = (src: string) =>
  /from\s+['"]@\/components\/layout\/AppHeader['"]/.test(src);
const importsPageLayout = (src: string) =>
  /from\s+['"]@\/components\/layout\/PageLayout['"]/.test(src);

const allTsx = [
  ...walkTsx(join(repoRoot, 'src', 'pages')),
  ...walkTsx(join(repoRoot, 'src', 'components')),
];
const appHeaderFiles = allTsx.filter((f) => importsAppHeader(readFileSync(f, 'utf8')));

describe('PageLayout adoption pin (FS-3)', () => {
  it('finds AppHeader pages to check (guards against a broken glob)', () => {
    // If this ever hits zero the walk/regex broke and the pin is vacuous.
    expect(appHeaderFiles.length).toBeGreaterThan(5);
  });

  it('every AppHeader page also imports PageLayout (except the shrinking allowlist)', () => {
    const violations = appHeaderFiles
      .map(rel)
      .filter(
        (r) =>
          !importsPageLayout(readFileSync(join(repoRoot, r), 'utf8')) && !(r in ALLOWLIST),
      );
    expect(
      violations,
      'These pages import AppHeader but hand-roll their own container. Render the body ' +
        'through <PageLayout> (src/components/layout/PageLayout.tsx), or — with a documented ' +
        'reason — add to ALLOWLIST:\n' +
        violations.map((v) => `  - ${v}`).join('\n'),
    ).toEqual([]);
  });

  it('allowlist has no stale entries (migrated or deleted pages must be delisted)', () => {
    const stale: string[] = [];
    for (const key of Object.keys(ALLOWLIST)) {
      let src: string;
      try {
        src = readFileSync(join(repoRoot, key), 'utf8');
      } catch {
        stale.push(`${key} (file no longer exists)`);
        continue;
      }
      if (!importsAppHeader(src)) stale.push(`${key} (no longer imports AppHeader)`);
      else if (importsPageLayout(src))
        stale.push(`${key} (now imports PageLayout — remove from allowlist)`);
    }
    expect(
      stale,
      'Stale ALLOWLIST entries — delete these:\n' + stale.map((s) => `  - ${s}`).join('\n'),
    ).toEqual([]);
  });
});
