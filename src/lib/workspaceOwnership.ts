// Ownership gate for workspace CREATION (#195).
//
// A user "owns" a workspace when any of their available workspaces carries the
// role 'owner'. This matters because there are TWO creation paths:
//
//   • First workspace  → the free 7-day-trial onboarding (`create_first_workspace`
//     RPC → checkout). The ONLY correct path for a user who owns nothing.
//   • Additional workspace → the $499 add-workspace flow (`create-workspace`),
//     which bills the owner's existing Stripe customer.
//
// A member of someone else's workspace who owns nothing has no Stripe customer,
// so the $499 flow dead-ends at an unsatisfiable "add a card" gate (#195). The
// UI must therefore route a zero-owned user to onboarding, not the paid flow.

export interface OwnershipRow {
  role: string;
}

/** True when the user owns at least one workspace (role === 'owner'). */
export function ownsAnyWorkspace(workspaces: ReadonlyArray<OwnershipRow>): boolean {
  return workspaces.some((w) => w.role === 'owner');
}

/**
 * Where the "New workspace" / "Create your first workspace" action should go.
 * Owners get the paid add-workspace dialog; everyone else (owns nothing) is
 * routed to the free-trial onboarding.
 */
export function workspaceCreationTarget(
  workspaces: ReadonlyArray<OwnershipRow>,
): 'add_workspace_dialog' | 'first_workspace_onboarding' {
  return ownsAnyWorkspace(workspaces) ? 'add_workspace_dialog' : 'first_workspace_onboarding';
}
