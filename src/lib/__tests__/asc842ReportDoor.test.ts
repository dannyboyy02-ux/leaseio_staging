import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Polish walkthrough 2026-07-17 (commit 9bce71a, cluster 2) — the disclosure
// -report door. The ASC 842 tab captured inputs but offered no way to the
// report they feed (the door was a buried admin page), and the report
// library's empty state pointed at a path that didn't exist for members.
// Pins: (a) the Generate button lives ON the ASC 842 tab, editor-gated;
// (b) the library empty state uses the honest copy and only shows the admin
// link to admin/owner roles.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('cluster 2 — Generate report from the ASC 842 tab', () => {
  const tab = read('src/components/leases/Asc842InputsTab.tsx');

  it('imports and wires useGenerateLeaseReport', () => {
    expect(tab).toContain("import { useGenerateLeaseReport } from '@/hooks/useGenerateLeaseReport';");
    expect(tab).toMatch(/generate: generateReport, isWorking: generatingReport \} = useGenerateLeaseReport\(\)/);
  });

  it('renders generate_report inside the canEdit branch of the sticky bar', () => {
    // Narrow to the sticky save bar so a stray reference elsewhere can't pass.
    const bar = tab.slice(tab.indexOf('sticky bottom-0'));
    expect(bar.length).toBeGreaterThan(0);
    const gate = bar.indexOf('{canEdit ? (');
    const gen = bar.indexOf("t('leases.asc842.generate_report')");
    expect(gate).toBeGreaterThan(-1);
    expect(gen).toBeGreaterThan(gate);
    // Viewers get an explanation, not a silently missing button.
    expect(bar).toContain("t('leases.asc842.report_viewer_hint')");
  });

  it('refuses to generate over unsaved edits (dirty guard)', () => {
    const handler = tab.slice(
      tab.indexOf('const handleGenerateReport'),
      tab.indexOf('async function handleSave'),
    );
    expect(handler).toContain('if (dirty)');
    expect(handler).toContain("t('leases.asc842.save_before_report')");
  });
});

describe('cluster 2 — honest report-library empty state', () => {
  const lib = read('src/pages/app/DisclosureReportLibrary.tsx');

  it('no longer references the removed no_reports_prefix key', () => {
    expect(lib).not.toContain('no_reports_prefix');
    expect(lib).toContain("t('reports.no_reports_empty')");
  });

  it('derives isAdminRole from admin/owner', () => {
    expect(lib).toContain("const isAdminRole = userRole === 'admin' || userRole === 'owner';");
  });

  it('shows the admin-page link only to admins; members get their own suffix', () => {
    // Narrow to the empty-state block following no_reports_empty.
    const at = lib.indexOf("t('reports.no_reports_empty')");
    expect(at).toBeGreaterThan(-1);
    const block = lib.slice(at, at + 800);
    expect(block).toContain('isAdminRole ? (');
    expect(block).toContain('"/app/admin/reports"');
    expect(block).toContain("t('reports.no_reports_member_suffix')");
  });
});
