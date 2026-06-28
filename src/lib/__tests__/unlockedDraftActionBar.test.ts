import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const readRepoFile = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * Regression guard for the unlocked-editing dead-end.
 *
 * Bug: when a user unlocks + edits an active lease, LeaseReview renders the
 * `isUnlockedDraft` action bar. That branch was missing the button that opens
 * the finalize/re-lock dialog (`setLockConfirmDialogOpen(true)`), so the user
 * was stranded — edits staged forever, lease stayed unlocked, no submit path.
 *
 * The fix wires a primary "Submit for approval" / "Lock" button into that
 * exact branch. (Copy was de-jargoned 2026-06-26: "Lock & submit"/"Re-lock"
 * → "Submit for approval"/"Lock"; the button + wiring are unchanged.)
 *
 * Why this is a NARROWED-WINDOW static test (per CLAUDE.md gotcha): the file
 * also contains an UNREACHABLE `setLockConfirmDialogOpen(true)` at the
 * `primaryAction` builder's `canShowLock` branch — but `primaryAction` returns
 * `null` early for `isUnlockedDraft` (`if (isUnlockedDraft) return null;`), so
 * that call site can NEVER fire in the unlocked-draft state. A full-file
 * `toContain('setLockConfirmDialogOpen(true)')` would pass on that unreachable
 * site and give a FALSE guard. We therefore slice the source down to the
 * `isUnlockedDraft ? ( ... )` JSX branch and assert the wiring lives INSIDE it.
 *
 * The two call sites are also syntactically distinguishable:
 *   - unreachable builder: object property  `onClick: () => setLockConfirmDialogOpen(true),`
 *   - the fix (JSX prop):  `onClick={async () => { await flushStagedEdits(); setLockConfirmDialogOpen(true); }}`
 * We assert the JSX form is present in the block and the object form is absent,
 * so the test cannot pass merely because the unreachable site exists.
 */
describe('unlocked-draft action bar — finalize/re-lock affordance', () => {
  const source = readRepoFile('src/pages/app/LeaseReview.tsx');

  /** Slice from the `isUnlockedDraft ? (` JSX branch to its `) : (` else-branch. */
  const unlockedDraftBlock = (() => {
    const startIdx = source.indexOf('isUnlockedDraft ? (');
    expect(startIdx, 'isUnlockedDraft JSX branch must exist in LeaseReview').toBeGreaterThan(-1);
    const elseIdx = source.indexOf(') : (', startIdx);
    expect(elseIdx, 'isUnlockedDraft ternary must have an else branch').toBeGreaterThan(startIdx);
    return source.slice(startIdx, elseIdx);
  })();

  it('exposes exactly one finalize/re-lock wiring inside the unlocked-draft branch', () => {
    const occurrences = (unlockedDraftBlock.match(/setLockConfirmDialogOpen\(true\)/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('wires the finalize dialog as a JSX onClick prop (not the unreachable builder form)', () => {
    // The reachable, in-bar button wires the dialog via a JSX onClick prop
    // (the handler flushes pending edits first, then opens the dialog).
    expect(unlockedDraftBlock).toMatch(/onClick=\{[^}]*setLockConfirmDialogOpen\(true\)/);
    // The unreachable primaryAction-builder object-property form must NOT be how
    // the unlocked-draft branch gets its dialog — proves the guard distinguishes
    // "button wired in the unlocked-draft bar" from "call exists somewhere in file".
    expect(unlockedDraftBlock).not.toContain('onClick: () => setLockConfirmDialogOpen(true)');
  });

  it('labels the button as a submit/lock primary action so it is not removed silently', () => {
    // Guards against the button being gutted to a no-op or relabeled away from
    // its submit semantics while keeping the onClick. Quoted to match the label
    // literals (not the <Lock> icon or setLockConfirmDialogOpen identifiers).
    expect(unlockedDraftBlock).toContain("'Submit for approval'");
    expect(unlockedDraftBlock).toContain("'Lock'");
  });

  it('confirms the unreachable builder call site still exists OUTSIDE the branch (so the narrowing is load-bearing)', () => {
    // If this ever fails, the file structure changed and the narrowing window
    // assumptions above should be re-checked. There are two known call sites:
    // the unreachable builder (object form) and the in-bar JSX button.
    const total = (source.match(/setLockConfirmDialogOpen\(true\)/g) || []).length;
    expect(total).toBe(2);
    expect(source).toContain('onClick: () => setLockConfirmDialogOpen(true)');
  });

  // Phase A — active-edit mode coherence: an inline, NON-destructive "Cancel"
  // secondary now sits next to Submit in the unlocked-draft bar. It is the only
  // non-Archive exit from an edit session (discard unsaved staged edits + re-lock,
  // lease itself untouched). Pin that it lives INSIDE the branch and is wired to
  // the change-set cancel dialog — not Archive, and not the lock/submit dialog —
  // so the edit-session exit can't silently regress into a dead-end again.
  it('exposes an inline Cancel that discards the change set (not Archive, not the submit dialog)', () => {
    // The cancel affordance is wired to the change-set cancel dialog...
    expect(unlockedDraftBlock).toMatch(/onClick=\{[^}]*setCancelChangeSetDialogOpen\(true\)/);
    // ...and is labeled "Cancel" (de-jargoned secondary, not "Discard"/"Archive").
    expect(unlockedDraftBlock).toContain('Cancel');
    // It must NOT route the edit-session exit through the lock/submit dialog — that
    // path is the Submit primary, a different gesture.
    expect(unlockedDraftBlock).not.toMatch(/onClick=\{[^}]*setCancelChangeSetDialogOpen[^}]*setLockConfirmDialogOpen/);
  });

  it('renders Cancel as a neutral (outline) secondary, not a destructive button', () => {
    // The Cancel is intentionally non-destructive (cancelling touches only the
    // unsaved change set, never the lease). Guard that it stays a neutral
    // outline button so it doesn't get restyled into a red "delete the lease"
    // affordance. Slice to the Cancel button element to keep the assertion local.
    const cancelStart = unlockedDraftBlock.indexOf('setCancelChangeSetDialogOpen(true)');
    expect(cancelStart, 'Cancel onClick must exist in the unlocked-draft branch').toBeGreaterThan(-1);
    // Walk back to the opening <Button of the Cancel control.
    const buttonOpen = unlockedDraftBlock.lastIndexOf('<Button', cancelStart);
    const cancelButton = unlockedDraftBlock.slice(buttonOpen, cancelStart);
    expect(cancelButton).toContain('variant="outline"');
    expect(cancelButton).not.toContain('variant="destructive"');
  });
});
