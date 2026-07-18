import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #177b — approval-policy list + editor polish. Static pins:
//   Part 1: the list page's redundant "Archive" icon-button (identical effect
//   to the adjacent Active/Inactive Switch, behind a native window.confirm and
//   a misnomer — nothing is removed from the list) is GONE; the Switch owns
//   activation.
//   Part 2: the editor's "Try it on a sample request" tester calls the SQL RPC
//   preview_policy_resolution, which resolves against SAVED approval_policies
//   rows only — the button is gated (testerStale) while the draft is unsaved
//   or dirty, with an inline note. The gate reuses the SAME uiId-stripped
//   serializePolicy snapshot as the #174 unsaved-changes guard (one snapshot
//   mechanism, deliberately — see unsavedNavGuard.test.ts for the guard pins).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#177b part 1 — no redundant Archive action on the policy list', () => {
  const list = read('src/pages/settings/ApprovalPoliciesListPage.tsx');

  it('has no native confirm()', () => {
    expect(list).not.toMatch(/\bconfirm\s*\(/);
  });

  it('the Archive misnomer and its locale key are gone from the file', () => {
    expect(list).not.toMatch(/\bArchive\b/);
    expect(list).not.toContain('archive_confirm');
  });

  it('the row Switch still owns activation', () => {
    expect(list).toContain('onCheckedChange={(v) => toggleActive(p, v)}');
  });

  it('the orphaned archive_confirm key is gone from both locale files', () => {
    const en = JSON.parse(read('src/locales/en/common.json'));
    const es = JSON.parse(read('src/locales/es/common.json'));
    expect(en.policy_editor.list.archive_confirm).toBeUndefined();
    expect(es.policy_editor.list.archive_confirm).toBeUndefined();
  });
});

describe('#177b part 2 — editor tester gated while the draft is unsaved', () => {
  const edit = read('src/pages/settings/ApprovalPolicyEditPage.tsx');

  it('computes testerStale from the uiId-stripped snapshot (always stale for a new rule)', () => {
    expect(edit).toContain('serializePolicy');
    expect(edit).toMatch(/const testerStale = isNew \|\|/);
  });

  it('disables the sample tester on testerStale', () => {
    expect(edit).toContain('disabled={saving || !workspace?.id || testerStale}');
  });

  it('explains the gate with the save-first note beside the button', () => {
    const i = edit.indexOf("t('policy_editor.tester_save_first')");
    expect(i).toBeGreaterThan(-1);
    // The note renders in the sticky footer, gated on testerStale.
    expect(edit.slice(Math.max(0, i - 200), i)).toContain('testerStale &&');
  });

  it('the save-first note exists in both locale files', () => {
    const en = JSON.parse(read('src/locales/en/common.json'));
    const es = JSON.parse(read('src/locales/es/common.json'));
    expect(typeof en.policy_editor.tester_save_first).toBe('string');
    expect(typeof es.policy_editor.tester_save_first).toBe('string');
  });
});
