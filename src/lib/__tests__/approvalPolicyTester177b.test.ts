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

  // SUPERSEDED by the approval-rules redesign: the row's inline Active Switch
  // is gone along with the priority badge, the ⭐ badge, the chips and the
  // pencil. Activation now lives in the row's kebab as Pause / Resume, which
  // states the state in WORDS rather than in a switch position — and it is the
  // same single code path the "turn it off instead" delete refusal reuses.
  it('activation lives in the row kebab, not an inline Switch', () => {
    expect(list).toContain('onTogglePaused={(next) => void setPaused(p, next)}');
    // The remaining Switch on the page is the workspace-level separation-of-
    // duties default, not a per-rule control.
    expect(list).not.toContain('toggleActive');
  });

  it('the orphaned archive_confirm key is gone from both locale files', () => {
    const en = JSON.parse(read('src/locales/en/common.json'));
    const es = JSON.parse(read('src/locales/es/common.json'));
    expect(en.policy_editor.list.archive_confirm).toBeUndefined();
    expect(es.policy_editor.list.archive_confirm).toBeUndefined();
  });
});

// SUPERSEDED 2026-08-02 by the Approval Rules redesign. #177b's part 2 pinned a
// gate: the editor's tester called preview_policy_resolution, which only ever
// sees SAVED approval_policies rows, so the button was disabled while the draft
// was dirty and apologised with a "save first" note. The redesign removes the
// premise rather than the symptom — the editor now answers "what does this rule
// do?" from DRAFT state via describeChain (the same pure helper the rules list
// and the page hero use), so there is nothing to gate and nothing to apologise
// for. These pins therefore assert the ABSENCE of the gate and the PRESENCE of
// the draft-state answer; reintroducing testerStale would fail this block.
describe('editor answers from draft state — the save-first gate is retired', () => {
  const edit = read('src/pages/settings/ApprovalPolicyEditPage.tsx');
  // Absence assertions MUST run against CODE, not prose: the file's comments
  // deliberately name the retired machinery (testerStale, the RPC, the modal)
  // to explain why it is gone, and a naive toContain would match those and
  // report a regression that does not exist. Strip comments first.
  const code = edit
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  it('computes the answer from the draft steps, not from a saved-row round-trip', () => {
    expect(code).toContain('describeChain(');
    // The draft's two stages are what feed it.
    expect(code).toMatch(/conceptSteps\.map/);
    expect(code).toMatch(/signatorSteps\.map/);
    // No RPC call in the editor — the draft is not in the database yet, so a
    // resolver round-trip could only ever describe the last SAVED version.
    expect(code).not.toContain('preview_policy_resolution');
  });

  it('has no testerStale gate, no disabled tester, and no save-first apology', () => {
    expect(code).not.toContain('testerStale');
    expect(code).not.toContain('tester_save_first');
    expect(code).not.toContain('ApprovalPolicyTestDialog');
  });

  it('re-renders the answer when the language changes (i18next singleton contract)', () => {
    // describeChain renders through the i18next singleton at call time, so any
    // memo over it MUST carry `language` or the answer stays in the old locale.
    const i = edit.indexOf('describeChain(');
    expect(i).toBeGreaterThan(-1);
    const memoDeps = edit.slice(i, i + 900);
    expect(memoDeps).toContain('language');
  });

  it('the retired save-first note is gone from both locale files', () => {
    const en = JSON.parse(read('src/locales/en/common.json'));
    const es = JSON.parse(read('src/locales/es/common.json'));
    expect(en.policy_editor.tester_save_first).toBeUndefined();
    expect(es.policy_editor.tester_save_first).toBeUndefined();
  });
});
