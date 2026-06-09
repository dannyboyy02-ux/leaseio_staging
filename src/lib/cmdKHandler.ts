// Pure decision logic for whether a keydown event should open the workspace
// command palette. Extracted so the sidebar can stay declarative and the
// behavior can be unit-tested without standing up the whole authenticated
// shell. Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.1 + §P2.11 MED.
//
// Suppressions (return false = do NOT open the palette):
//   - Key isn't 'k' or the meta/ctrl modifier isn't held.
//   - A Radix Dialog/Sheet is open (detected via the data-scroll-locked
//     attribute Radix sets on document.body — the portable, library-agnostic
//     check the spec calls out).
//   - The NewWorkspaceDialog is open (a sidebar-owned state flag).
//   - Focus is in an INPUT / TEXTAREA / contenteditable (so typing 'cmd+k'
//     while editing a field doesn't hijack).

export interface CmdKDecisionInputs {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  /** True iff a Radix Dialog/Sheet is currently open. */
  dialogOpen: boolean;
  /** True iff the NewWorkspaceDialog state flag is set. */
  newWorkspaceOpen: boolean;
  /** Tag name of document.activeElement (e.g. 'INPUT', 'TEXTAREA', 'BUTTON'). */
  focusedTag: string | null;
  /** True iff document.activeElement is contenteditable. */
  focusedContentEditable: boolean;
}

export function shouldOpenCommandPalette(inputs: CmdKDecisionInputs): boolean {
  if (inputs.key !== "k") return false;
  if (!inputs.metaKey && !inputs.ctrlKey) return false;
  if (inputs.newWorkspaceOpen) return false;
  if (inputs.dialogOpen) return false;
  if (
    inputs.focusedTag === "INPUT" ||
    inputs.focusedTag === "TEXTAREA" ||
    inputs.focusedContentEditable
  ) {
    return false;
  }
  return true;
}
