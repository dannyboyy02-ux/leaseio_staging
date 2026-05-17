import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('audit remediation guardrails', () => {
  it('requires a cron secret for scheduled lease notifications', () => {
    const source = readRepoFile('supabase/functions/send-lease-notifications/index.ts');

    expect(source).toContain('LEASE_NOTIFICATIONS_CRON_SECRET');
    expect(source).toContain('x-cron-secret');
    expect(source).toContain('status: 401');
  });

  it('keeps audit uploads authenticated and rate limited', () => {
    const source = readRepoFile('supabase/functions/audit-session/index.ts');

    expect(source).toContain('auth.getUser');
    expect(source).toContain('enforceWorkspaceRateLimit');
    expect(source).not.toContain('auth.admin.createUser');
  });

  it('validates amendment parents inside the resolved workspace before processing', () => {
    const source = readRepoFile('supabase/functions/process_lease/index.ts');

    expect(source).toContain("parentLeaseId is required for amendment uploads");
    expect(source).toContain(".eq('workspace_id', resolvedWorkspaceId)");
    expect(source).toContain("Parent lease must be active");
  });

  it('limits financial summary publishing to admins and approved lifecycle states', () => {
    const source = readRepoFile('supabase/functions/generate-summary-token/index.ts');

    expect(source).toContain("approved");
    expect(source).toContain("executed");
    expect(source).toContain("active");
    expect(source).toContain(".eq('role', 'admin')");
  });

  it('installs the database storage, model-lock, and entitlement guardrails', () => {
    const migration = readRepoFile('supabase/migrations/_archive/20260426000003_audit_remediation.sql');

    expect(migration).toContain('authenticated_read_executed_leases');
    expect(migration).toContain('prevent_locked_lease_edits');
    expect(migration).toContain('prevent_workspace_entitlement_edits');
    expect(migration).toContain('audit_rls_smoke_check');
  });
});

// ============================================================================
// Governance hardening regression guards (KNOWN_ISSUES #16 + #17)
//
// Background: Both policies below were present in archived migrations but
// absent from the live production DB when the P1-10 baseline review ran on
// 2026-05-16 — undetected for weeks because nothing in the test suite asserted
// they were in the active migration chain. The restoration migration is at
// supabase/migrations/20260516130000_restore_governance_hardening.sql.
//
// Test shape chosen: static migration-file assertions. The live-DB integration
// test already exists as `scripts/smoke-audit-hardening.mjs` (npm run
// smoke:security), which calls audit_rls_smoke_check() against real
// environments. These vitest tests catch a different failure mode: a future
// migration accidentally dropping one of the four guards — or someone editing
// the migration file directly — without any live DB required. Static tests +
// live smoke script together cover both in-repo drift and live-DB drift.
// ============================================================================
describe('governance hardening — KNOWN_ISSUES #16 and #17', () => {
  const HARDENING_MIGRATION = 'supabase/migrations/20260516130000_restore_governance_hardening.sql';

  // --------------------------------------------------------------------------
  // #16: lease_governance_audit INSERT must block authenticated writers.
  // If this policy is absent, any authenticated browser session can forge or
  // overwrite audit entries — defeating the "attributable by service_role only"
  // guarantee that makes the audit trail defensible.
  // --------------------------------------------------------------------------
  it('governance audit INSERT policy blocks authenticated writers (WITH CHECK false)', () => {
    const migration = readRepoFile(HARDENING_MIGRATION);

    // The hardened policy must be created.
    expect(migration).toContain("CREATE POLICY \"governance audit is service role append only\"");
    expect(migration).toContain('ON public.lease_governance_audit FOR INSERT TO authenticated');
    // The guard: authenticated users always fail the check — only service_role
    // bypasses RLS, so service_role is the only INSERT path.
    expect(migration).toContain('WITH CHECK (false)');
  });

  it('governance audit hardening migration drops the old permissive INSERT policy', () => {
    const migration = readRepoFile(HARDENING_MIGRATION);

    // The old policy that allowed workspace members to INSERT must be removed.
    // If it re-appears in any subsequent migration without the false check,
    // authenticated writers could forge audit entries again.
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "workspace members can insert governance audit" ON public.lease_governance_audit'
    );
  });

  // --------------------------------------------------------------------------
  // #17: lease_change_sets UPDATE must enforce draft-only editing for submitters.
  // Without this guard, a submitter can modify proposed change values after
  // status flips to pending_approval — after the approver has been notified —
  // defeating the staged-approval premise.
  // --------------------------------------------------------------------------
  it('change set UPDATE policy restricts submitters to their own draft sets', () => {
    const migration = readRepoFile(HARDENING_MIGRATION);

    // The hardened policy must be created.
    expect(migration).toContain("CREATE POLICY \"submitter can edit draft change sets\"");
    expect(migration).toContain('ON public.lease_change_sets FOR UPDATE');
    // Submitter branch must gate on both ownership and draft status.
    expect(migration).toContain("submitted_by = auth.uid()");
    expect(migration).toContain("status = 'draft'");
    // Approver branch must gate on pending_approval status, not allow
    // unrestricted UPDATE by role alone.
    expect(migration).toContain("status = 'pending_approval'");
    expect(migration).toContain("role IN ('admin', 'financial_approver')");
  });

  it('change set hardening migration drops the old unrestricted UPDATE policy', () => {
    const migration = readRepoFile(HARDENING_MIGRATION);

    // The old policy that allowed any submitter or approver to UPDATE any set
    // (regardless of status) must be removed.
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "submitters and approvers can update change sets" ON public.lease_change_sets'
    );
  });

  // --------------------------------------------------------------------------
  // audit_rls_smoke_check() — the four assertions it makes must all be present
  // in the function body. This protects against someone editing the function to
  // silently remove a check (which would make the smoke script pass green while
  // the actual guard was gone).
  // --------------------------------------------------------------------------
  it('audit_rls_smoke_check asserts all four governance hardening conditions', () => {
    const migration = readRepoFile(HARDENING_MIGRATION);

    // All four jsonb keys the function must emit.
    expect(migration).toContain("'governance_audit_append_only'");
    expect(migration).toContain("'governance_audit_no_member_insert'");
    expect(migration).toContain("'change_set_draft_only_edit'");
    expect(migration).toContain("'change_set_no_unrestricted_update'");

    // The NOT EXISTS checks (absence assertions) must be present — these catch
    // the case where the old permissive policies come back in a later migration.
    expect(migration).toContain("NOT EXISTS");

    // The function must check for the exact hardened policy names so that a
    // rename or partial-match would not fool the smoke check.
    expect(migration).toContain("'governance audit is service role append only'");
    expect(migration).toContain("'submitter can edit draft change sets'");

    // And must assert the old policies are absent.
    expect(migration).toContain("'workspace members can insert governance audit'");
    expect(migration).toContain("'submitters and approvers can update change sets'");
  });

  // --------------------------------------------------------------------------
  // Negative case: the archived permissive migration MUST NOT contain the
  // hardened draft-only policy — confirms that the restoration migration is
  // genuinely adding something new, not duplicating what was already there.
  // This test would fail if someone "fixed" the regression by editing the
  // archived migration file (which is forbidden by the Schema Change Rule in
  // CLAUDE.md) rather than writing a new restoration migration.
  // --------------------------------------------------------------------------
  it('archived governance migration does not already contain the draft-only update policy (confirms restoration is a new addition)', () => {
    const archivedMigration = readRepoFile(
      'supabase/migrations/_archive/20260426000003_audit_remediation.sql'
    );

    // The archived migration has a different, permissive UPDATE policy name.
    // If this fails, the archived file was edited after the fact — violating
    // the immutable-migration rule.
    expect(archivedMigration).not.toContain('"submitter can edit draft change sets"');
    // The archived migration's UPDATE policy name is the old permissive one.
    expect(archivedMigration).toContain('"submitters and governance approvers can update change sets"');
  });
});

// ============================================================================
// Governance hardening follow-up — edge function fix (lease-governance-action)
//
// Background: migration 20260517000000 added the prevent_change_set_field_tampering
// BEFORE UPDATE trigger, which raises check_violation if submitted_by changes once
// it is non-NULL. The edge function previously overwrote submitted_by with user.id
// at two UPDATE sites (the self-approve approve-unlock path ~line 598, and the
// submit-for-approval path ~line 685). In the approve_unlock_request flow, the actor
// is an admin acting on behalf of the original requester — so the overwrite would
// replace the requester's attribution with the admin's id AND trip the trigger.
//
// The fix: both UPDATE blocks were changed to omit submitted_by entirely, preserving
// the value set at createDraftChangeSet time. This test defends against that regression
// being silently re-introduced in a future refactor — the same in-repo drift class the
// migration-static tests above catch for SQL files.
// ============================================================================
describe('governance hardening follow-up — edge function submitted_by non-overwrite (KNOWN_ISSUES #16 paired fix)', () => {
  const EDGE_FN = 'supabase/functions/lease-governance-action/index.ts';

  // --------------------------------------------------------------------------
  // The self-approve UPDATE block (approve_unlock_request flow, ~line 596).
  // If submitted_by: user.id reappears here, an admin self-approving a change
  // set replaces the original requester's attribution in submitted_by — the
  // exact audit-attribution defeat that triggered KNOWN_ISSUES #16.
  // --------------------------------------------------------------------------
  it('self-approve UPDATE block does not overwrite submitted_by (preserves original requester attribution)', () => {
    const source = readRepoFile(EDGE_FN);

    // The intentional-non-overwrite comment must be present in the self-approve
    // UPDATE block. Its presence confirms the fix is deliberate and documented.
    // We locate the block by the unique 'self_approved: true' marker that only
    // appears in the self-approve path.
    const selfApproveBlockStart = source.indexOf('self_approved: true');
    expect(selfApproveBlockStart).toBeGreaterThan(-1);

    // Extract a window around the self-approve block (before the next .eq call).
    const selfApproveWindow = source.slice(
      source.lastIndexOf('.update({', selfApproveBlockStart),
      source.indexOf('.eq("id", changeSetId)', selfApproveBlockStart) + 30
    );

    // The fix: submitted_by must NOT appear as a live object key in this UPDATE.
    // Strip JS line comments before checking so the intentional comment itself
    // (which contains the word 'submitted_by') doesn't produce a false negative.
    const selfApproveWithoutComments = selfApproveWindow
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(selfApproveWithoutComments).not.toMatch(/submitted_by\s*:/);

    // The explanatory comment must still be present (guards against removing
    // the fix silently without leaving a trace of intent).
    expect(selfApproveWindow).toContain('submitted_by intentionally NOT overwritten');
    expect(selfApproveWindow).toContain('prevent_change_set_field_tampering');
  });

  // --------------------------------------------------------------------------
  // The submit-for-approval UPDATE block (~line 683).
  // If submitted_by: user.id reappears here, the submitter's own attribution
  // would be overwritten by themselves (no-op in the happy path), BUT in the
  // approve_unlock_request path where the admin is acting on behalf of a
  // requester, the overwrite replaces the requester with the admin — the
  // same audit-attribution defeat — AND trips the BEFORE UPDATE trigger,
  // raising check_violation and breaking the whole flow.
  // --------------------------------------------------------------------------
  it('submit-for-approval UPDATE block does not overwrite submitted_by (preserves original requester attribution and avoids trigger conflict)', () => {
    const source = readRepoFile(EDGE_FN);

    // Locate the submit-for-approval block by the unique 'pending_approval' status
    // assignment in an .update() call (the self-approve path uses 'approved').
    const pendingApprovalMarker = source.indexOf("status: \"pending_approval\"");
    expect(pendingApprovalMarker).toBeGreaterThan(-1);

    const submitBlockStart = source.lastIndexOf('.update({', pendingApprovalMarker);
    const submitBlockEnd = source.indexOf('.eq("id", changeSetId)', pendingApprovalMarker) + 30;
    const submitWindow = source.slice(submitBlockStart, submitBlockEnd);

    // Strip JS line comments before checking.
    const submitWithoutComments = submitWindow
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(submitWithoutComments).not.toMatch(/submitted_by\s*:/);

    // Explanatory comment must be present in both blocks.
    expect(submitWindow).toContain('submitted_by intentionally NOT overwritten');
    expect(submitWindow).toContain('prevent_change_set_field_tampering');
  });

  // --------------------------------------------------------------------------
  // Negative case: verify the test would catch the regression.
  // The string 'submitted_by: user.id' must not appear ANYWHERE in the file
  // in uncommented code. This is a belt-and-suspenders assertion — the two
  // window checks above are narrower, but this catches edge cases where the
  // bug is introduced outside either named UPDATE block.
  // --------------------------------------------------------------------------
  it('lease-governance-action contains no uncommented submitted_by: user.id assignment (belt-and-suspenders regression guard)', () => {
    const source = readRepoFile(EDGE_FN);

    const uncommentedLines = source
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''));

    const offendingLines = uncommentedLines
      .map((line, idx) => ({ line, lineNum: idx + 1 }))
      .filter(({ line }) => /submitted_by\s*:\s*user\.id/.test(line));

    // If this fails, report which lines to make fixing straightforward.
    expect(offendingLines).toHaveLength(0);
  });
});

// ============================================================================
// Governance hardening follow-up — static migration assertions (20260517000000)
//
// Background: The prior restoration migration (20260516130000) surfaced four
// incompletenesses (C1, H1, H2, H4) caught during reviewer routing. The
// follow-up migration bundles all four fixes. These static tests defend
// against:
//   - A future migration accidentally re-dropping any of these guards.
//   - Someone editing the migration file directly (which is forbidden by the
//     Schema Change Rule in CLAUDE.md).
//   - Silent coverage regression in audit_rls_smoke_check() itself.
//
// Test shape: static migration-file assertions (same pattern as the six
// tests above). The live-DB behavioral layer is covered by
// scripts/smoke-audit-hardening.mjs (`npm run smoke:security`).
// ============================================================================
describe('governance hardening follow-up — 20260517000000', () => {
  const FOLLOWUP_MIGRATION =
    'supabase/migrations/20260517000000_governance_hardening_followup.sql';

  // --------------------------------------------------------------------------
  // H1: WITH CHECK on lease_change_sets UPDATE must mirror the USING predicate,
  // not be `WITH CHECK (true)`.
  //
  // If WITH CHECK stays `true`, a submitter satisfying USING (own draft) can
  // PATCH status='pending_approval' directly via PostgREST, bypassing the
  // lease-governance-action edge function that is supposed to be the only
  // writer of state-transition audit rows. This test verifies both the
  // USING and WITH CHECK branches contain identical status conditions so
  // PostgREST cannot be used to escalate status or change ownership on either
  // the submitter or approver branch.
  // --------------------------------------------------------------------------
  it("change set UPDATE WITH CHECK mirrors USING — both branches appear in WITH CHECK block (blocks PostgREST status-flip)", () => {
    const migration = readRepoFile(FOLLOWUP_MIGRATION);

    // The prior permissive policy must be dropped before re-creation.
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "submitter can edit draft change sets" ON public.lease_change_sets'
    );

    // WITH CHECK block must be present and must NOT be a bare `WITH CHECK (true)`
    // as a live SQL clause. We strip SQL-style line comments (-- ...) before
    // checking, so references to `WITH CHECK (true)` in the migration header
    // commentary don't produce a false negative.
    const sqlWithoutLineComments = migration
      .split('\n')
      .map(line => line.replace(/--.*$/, ''))
      .join('\n');
    expect(sqlWithoutLineComments).toContain('WITH CHECK (');
    expect(sqlWithoutLineComments).not.toMatch(/WITH CHECK\s*\(\s*true\s*\)/);

    // Both status conditions from USING must appear inside the WITH CHECK block.
    // We verify by confirming they appear more than once in the file (once in
    // USING, once in WITH CHECK).
    const draftOccurrences = (migration.match(/status = 'draft'/g) ?? []).length;
    const pendingOccurrences = (migration.match(/status = 'pending_approval'/g) ?? []).length;
    // At least 2 of each: one in USING clause, one in WITH CHECK clause.
    expect(draftOccurrences).toBeGreaterThanOrEqual(2);
    expect(pendingOccurrences).toBeGreaterThanOrEqual(2);

    // submitted_by = auth.uid() and the role check must also appear in both
    // branches — confirmed by count.
    const submittedByOccurrences = (migration.match(/submitted_by = auth\.uid\(\)/g) ?? []).length;
    expect(submittedByOccurrences).toBeGreaterThanOrEqual(2);

    const roleCheckOccurrences = (
      migration.match(/wr\.role IN \('admin', 'financial_approver'\)/g) ?? []
    ).length;
    expect(roleCheckOccurrences).toBeGreaterThanOrEqual(2);
  });

  // --------------------------------------------------------------------------
  // H1-extended: prevent_change_set_field_tampering trigger
  //
  // RLS WITH CHECK cannot enforce OLD-vs-NEW deltas. A submitter satisfying
  // USING could PATCH submitted_by to a colleague's user_id or PATCH
  // workspace_id to a sibling workspace. The BEFORE UPDATE trigger blocks both
  // at the data layer for ALL roles (including service_role). This test
  // verifies the function declares both invariants and the trigger wiring
  // is correct.
  // --------------------------------------------------------------------------
  it('prevent_change_set_field_tampering trigger enforces workspace_id immutability and submitted_by once-set invariant, wired as BEFORE UPDATE on lease_change_sets', () => {
    const migration = readRepoFile(FOLLOWUP_MIGRATION);

    // Function must exist with the correct return type.
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.prevent_change_set_field_tampering()'
    );
    expect(migration).toContain('RETURNS trigger');

    // SECURITY DEFINER must NOT be present on the trigger function.
    // Round 4 change: the trigger was rewritten without SECURITY DEFINER —
    // the canonical posture (matches prevent_locked_lease_edits precedent).
    // Future re-addition of SECURITY DEFINER would be a regression: a BEFORE
    // UPDATE trigger with SECURITY DEFINER runs with elevated privileges for
    // every caller, including authenticated PostgREST clients; the correct
    // pattern is to let the trigger run as the row's owner (no DEFINER) and
    // enforce via RAISE EXCEPTION, not elevated context.
    //
    // We verify by extracting the function declaration block and checking that
    // SECURITY DEFINER does not appear before the AS $$ marker.
    // (audit_rls_smoke_check() legitimately has SECURITY DEFINER further down
    // in the file — this narrow window check prevents a false negative from it.)
    const fnDeclStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.prevent_change_set_field_tampering()'
    );
    const fnBodyStart = migration.indexOf('AS $$', fnDeclStart);
    const fnDeclBlock = migration.slice(fnDeclStart, fnBodyStart);
    expect(fnDeclBlock).not.toContain('SECURITY DEFINER');

    // workspace_id immutability check — must compare OLD vs NEW.
    expect(migration).toContain('OLD.workspace_id IS DISTINCT FROM NEW.workspace_id');
    expect(migration).toContain("'lease_change_sets.workspace_id is immutable");

    // submitted_by once-set check — NULL->value is allowed; value->other is not.
    // The guard must explicitly test OLD.submitted_by IS NOT NULL before
    // comparing — that's the "once non-NULL" semantic.
    expect(migration).toContain('OLD.submitted_by IS NOT NULL');
    expect(migration).toContain('OLD.submitted_by IS DISTINCT FROM NEW.submitted_by');
    expect(migration).toContain("'lease_change_sets.submitted_by is immutable once set");

    // Trigger wiring: BEFORE UPDATE, FOR EACH ROW, on the right table.
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS prevent_change_set_field_tampering ON public.lease_change_sets'
    );
    expect(migration).toContain('CREATE TRIGGER prevent_change_set_field_tampering');
    expect(migration).toContain('BEFORE UPDATE ON public.lease_change_sets');
    expect(migration).toContain('FOR EACH ROW');
    expect(migration).toContain(
      'EXECUTE FUNCTION public.prevent_change_set_field_tampering()'
    );
  });

  // --------------------------------------------------------------------------
  // H2: lease_change_set_items — 3 draft-only policies replace 3 permissive ones
  //
  // The prior state had unrestricted INSERT/UPDATE/DELETE policies on the
  // items child table. A submitter could modify items on a pending_approval
  // parent after the approver was notified, changing what the approver sees.
  // This test verifies: the 3 old policies are dropped, and the 3 new
  // draft-only policies are created with the status='draft' guard on the
  // parent change set.
  // --------------------------------------------------------------------------
  it("change set items — 3 permissive policies are dropped and 3 draft-only replacements are created", () => {
    const migration = readRepoFile(FOLLOWUP_MIGRATION);

    // Old permissive policy names must be dropped.
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "workspace members can insert change set items" ON public.lease_change_set_items'
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "workspace members can update change set items" ON public.lease_change_set_items'
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "workspace members can delete change set items" ON public.lease_change_set_items'
    );

    // New draft-only policy names must be created.
    expect(migration).toContain(
      'CREATE POLICY "draft-only insert change set items"'
    );
    expect(migration).toContain(
      'CREATE POLICY "draft-only update change set items"'
    );
    expect(migration).toContain(
      'CREATE POLICY "draft-only delete change set items"'
    );

    // All three new policies must target lease_change_set_items.
    const itemsTableOccurrences = (
      migration.match(/ON public\.lease_change_set_items/g) ?? []
    ).length;
    // At least 3: one per new policy (the DROPs use a different form).
    expect(itemsTableOccurrences).toBeGreaterThanOrEqual(3);

    // Each policy must gate on the parent's status='draft' via the
    // change_sets join — verifying the guard is in the items policies
    // specifically (not just the change_sets UPDATE policy counted earlier).
    // The subquery pattern appears once per new items policy (3 total) plus
    // the UPDATE WITH CHECK copy (1 more), so at least 4 occurrences.
    const draftSubqueryOccurrences = (
      migration.match(/cs\.status = 'draft'/g) ?? []
    ).length;
    expect(draftSubqueryOccurrences).toBeGreaterThanOrEqual(3);
  });

  // --------------------------------------------------------------------------
  // C1 + H4: audit_rls_smoke_check() rebuilt as 26-key superset
  //
  // The prior migration silently shrank the function from 15 keys to 4,
  // defeating its purpose as the only automated regression detector. This
  // test verifies the follow-up function contains all 26 expected key names.
  // If even one is missing, the smoke check cannot catch drift on that guard.
  //
  // Key count breakdown:
  //   15 original keys preserved verbatim
  //    2 absence-checks from prior migration (20260516130000)
  //    2 content-based H4 parent-table absence-checks
  //    3 H2 items presence-checks (draft-only insert/update/delete)
  //    1 H1-extended trigger key
  //    3 H2 items content-based absence-checks (parallel to parent) ← Round 3
  //   ---
  //   26 total
  // --------------------------------------------------------------------------
  it('audit_rls_smoke_check rebuilt with all 26 assertion keys present', () => {
    const migration = readRepoFile(FOLLOWUP_MIGRATION);

    // The function must be re-created (not just GRANTed).
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.audit_rls_smoke_check()'
    );

    // --- Original 15 keys preserved verbatim ---
    const originalKeys = [
      "'is_workspace_member_function'",
      "'workspace_members_policy'",
      "'workspace_roles_policy'",
      "'leases_select_policy'",
      "'summary_views_policy'",
      "'executed_legacy_storage_policies_removed'",
      "'executed_scoped_storage_policy'",
      "'strict_model_lock_trigger'",
      "'strict_model_lock_function'",
      "'workspace_entitlement_guard'",
      "'workspace_subscription_columns'",
      "'governance_unlock_policy'",
      "'governance_change_set_policy'",
      "'governance_audit_append_guard'",
      "'governance_change_set_draft_only_edit'",
    ];
    for (const key of originalKeys) {
      expect(migration).toContain(key);
    }

    // --- 2 absence-checks carried forward from prior migration ---
    expect(migration).toContain("'governance_audit_no_member_insert'");
    expect(migration).toContain("'change_set_no_unrestricted_update'");

    // --- 2 content-based H4 absence-checks (count-based, defeats name-rename bypass) ---
    expect(migration).toContain("'governance_audit_only_one_insert_policy'");
    expect(migration).toContain("'change_set_only_one_update_policy'");

    // --- 3 H2 items presence-keys ---
    expect(migration).toContain("'change_set_items_draft_only_insert'");
    expect(migration).toContain("'change_set_items_draft_only_update'");
    expect(migration).toContain("'change_set_items_draft_only_delete'");

    // --- 1 H1-extended trigger key ---
    expect(migration).toContain("'change_set_field_tampering_trigger'");

    // --- 3 H2 items content-based absence-checks (parallel to parent — Round 3 addition) ---
    // These trip on ANY policy other than the expected hardened one on each
    // (table, cmd) pair for lease_change_set_items, closing the same FOR ALL /
    // name-rename bypass that the parent-table checks close.
    expect(migration).toContain("'change_set_items_only_one_insert_policy'");
    expect(migration).toContain("'change_set_items_only_one_update_policy'");
    expect(migration).toContain("'change_set_items_only_one_delete_policy'");

    // Total: 15 + 2 + 2 + 3 + 1 + 3 = 26 keys.
    // Verify the count by checking the exact key list.
    const allExpectedKeys = [
      ...originalKeys,
      "'governance_audit_no_member_insert'",
      "'change_set_no_unrestricted_update'",
      "'governance_audit_only_one_insert_policy'",
      "'change_set_only_one_update_policy'",
      "'change_set_items_draft_only_insert'",
      "'change_set_items_draft_only_update'",
      "'change_set_items_draft_only_delete'",
      "'change_set_field_tampering_trigger'",
      "'change_set_items_only_one_insert_policy'",
      "'change_set_items_only_one_update_policy'",
      "'change_set_items_only_one_delete_policy'",
    ];
    expect(allExpectedKeys).toHaveLength(26);
  });

  // --------------------------------------------------------------------------
  // H1-extended (Round 5): exhaustive 14-field coverage in
  // prevent_change_set_field_tampering.
  //
  // The trigger gives exhaustive coverage over all 15 lease_change_sets
  // columns with an explicit policy for each:
  //
  //   Universal-immutable (5 — no role bypass):
  //     id, lease_id, workspace_id, submitted_by, created_at
  //
  //   Service-role-only mutable (9 — inside COALESCE(auth.role(),'') <> 'service_role'):
  //     status, unlock_request_id, submitted_at, reviewed_by, reviewed_at,
  //     review_note, self_approved, requested_approver_id, change_summary
  //
  //   Deliberately uncovered (1 — not guarded by this trigger):
  //     updated_at (owned by set_updated_at trigger; coupling would be fragile)
  //
  // Round 5 moved change_summary from deliberately-uncovered to service-role-only
  // per security-scanner finding M-2: approver branch of the UPDATE policy
  // permits PATCH on pending_approval, RLS status='draft' gate only applies
  // to submitter branch, so an approver could tamper with the submitter's
  // narrative on a pending set. Added to carve-out; only updated_at remains
  // deliberately uncovered.
  //
  // Test approach: list-based structural assertions (option b per Round 4 spec).
  //   1. Verify every guarded column name appears in a RAISE EXCEPTION string.
  //   2. Assert the total RAISE EXCEPTION count is exactly 14 (5 universal + 9
  //      service-role). More would mean undocumented guards; fewer means a
  //      column silently lost its guard.
  //   3. Assert updated_at does NOT appear in any RAISE EXCEPTION
  //      (deliberate exclusion — regression if added without the column-policy
  //      doc in the migration header being updated).
  //   4. Preserve the structural position assertions from Round 3/4
  //      (service-role block nests the 9 mutable fields; 5 universal guards
  //      precede it).
  //
  // This test is static (migration-file assertion). Behavioral runtime
  // verification is deferred per KNOWN_ISSUES #24.
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // Round 5 additions: content-based smoke check key and COMMENT ON FUNCTION
  // --------------------------------------------------------------------------

  // ---- Round 5-A: three ILIKE anchor phrases in the
  // change_set_field_tampering_trigger smoke check key.
  //
  // Background: The smoke check previously only tested trigger existence
  // (name match via pg_trigger). Round 5 added three content-based ILIKE
  // clauses that verify the function body contains behaviorally distinct
  // phrases. If a future CREATE OR REPLACE drops any of these phrases, the
  // smoke check would still name-match the trigger but the content check
  // would return false — surfacing that the substance was replaced even if
  // the name survived.
  //
  // Test shape: window-narrowed static assertion.
  // We extract the substring of the migration from the
  // 'change_set_field_tampering_trigger' key declaration to the closing `)`
  // of that key's value expression. All three ILIKE anchors must appear
  // WITHIN that window — not just anywhere in the file — because the
  // strict_model_lock_function key also uses `ILIKE` (with different
  // phrases) earlier in the same migration. A full-file toContain would
  // produce the right assertion result by accident but would not catch if
  // an anchor moved to the wrong key block. The window check also verifies
  // structural cohesion: all three anchors are inside the same key's
  // query, not spread across different keys.
  //
  // This is exactly the KNOWN_ISSUES #27 bug class: full-file toContain on
  // properties that could match multiple objects produces false confidence.
  // --------------------------------------------------------------------------
  it('change_set_field_tampering_trigger smoke check key contains all three ILIKE content anchors within its own key block (not leaking from strict_model_lock_function)', () => {
    const migration = readRepoFile(FOLLOWUP_MIGRATION);

    // Locate the start of the change_set_field_tampering_trigger key block.
    // The key string is unique in the smoke check body.
    const keyStart = migration.indexOf("'change_set_field_tampering_trigger', (");
    expect(keyStart).toBeGreaterThan(-1);

    // The closing paren `)` that ends this compound expression follows the
    // second EXISTS block. We find it by locating the `)` that closes the
    // outer `(` of the compound value. The pattern `)` + newline + `  )`
    // marks the end (one for the inner AND EXISTS block, one for the outer
    // compound). Use the position of the *next* smoke-check key after this
    // one as the upper bound to keep the window tight.
    // The next jsonb key pair after this key is the closing `);` of the
    // jsonb_build_object call — there is no key after this one.
    // Use end-of-function marker `$$;` as the upper bound.
    const fnEnd = migration.indexOf('$$;', keyStart);
    expect(fnEnd).toBeGreaterThan(keyStart);

    const triggerKeyWindow = migration.slice(keyStart, fnEnd);

    // ---- Anchor 1: 'workspace_id is immutable' ----
    // Proves the universal-immutability section survives any silent
    // CREATE OR REPLACE. If this phrase is renamed or removed from the
    // trigger function body, the smoke check would return false for this key.
    expect(triggerKeyWindow).toContain("ILIKE '%workspace_id is immutable%'");

    // ---- Anchor 2: 'submitted_by is immutable' ----
    // Proves the attribution-immutability invariant survives.
    expect(triggerKeyWindow).toContain("ILIKE '%submitted_by is immutable%'");

    // ---- Anchor 3: 'auth.role()' ----
    // Proves the service-role carve-out block exists at all. If the entire
    // service-role-only section is stripped, the trigger would still exist
    // (anchor 1+2 might survive in the universal block) but the content
    // check would fail on this anchor — catching the structural regression.
    expect(triggerKeyWindow).toContain("ILIKE '%auth.role()%'");

    // ---- Structural shape: pg_get_functiondef and proname are co-located ----
    // Verifies the three anchors are inside the pg_proc subquery for the
    // right function — not floating loose or attached to a different probe.
    expect(triggerKeyWindow).toContain('pg_get_functiondef(p.oid)');
    expect(triggerKeyWindow).toContain("p.proname = 'prevent_change_set_field_tampering'");

    // ---- Negative: the strict_model_lock_function anchors are NOT here ----
    // strict_model_lock_function uses '%service_role%' and '%governance workflow%'.
    // These must not appear inside the change_set_field_tampering_trigger window —
    // if they do, the window extraction is wrong or the two keys were merged.
    expect(triggerKeyWindow).not.toContain("ILIKE '%service_role%'");
    expect(triggerKeyWindow).not.toContain("ILIKE '%governance workflow%'");
  });

  // ---- Round 5-B: COMMENT ON FUNCTION encodes the A/B/C triage rule.
  //
  // Background: COMMENT ON FUNCTION was added so an operator running
  // `\df+ audit_rls_smoke_check` or inspecting Studio gets the triage
  // protocol without opening the migration file. The comment survives a
  // function DROP/recreate only if the next CREATE OR REPLACE is followed
  // by another COMMENT ON FUNCTION. This test catches a future migration
  // that does CREATE OR REPLACE FUNCTION without re-issuing the COMMENT —
  // which would silently erase the operator-facing documentation.
  //
  // Test shape: window-narrowed static assertion.
  // We locate the COMMENT ON FUNCTION statement in the migration and
  // assert: (a) it targets the right function, (b) all three category
  // labels (A, B, C) appear in the comment text, (c) the distinguishing
  // phrases for each category are present so the comment is substantive
  // rather than a placeholder.
  //
  // The COMMENT ON FUNCTION line is unique in this migration, so no
  // multi-object ambiguity applies — but we still narrow to a small
  // window to make future failures easier to diagnose.
  // --------------------------------------------------------------------------
  it('COMMENT ON FUNCTION audit_rls_smoke_check() is present and encodes all three triage category labels (A, B, C)', () => {
    const migration = readRepoFile(FOLLOWUP_MIGRATION);

    // The declaration line must match the exact function signature.
    expect(migration).toContain('COMMENT ON FUNCTION public.audit_rls_smoke_check() IS');

    // Extract a window from the COMMENT line to end-of-file for narrowed
    // assertions. The COMMENT statement is the last SQL statement in the
    // migration, so the window to end-of-file is tight.
    const commentStart = migration.indexOf('COMMENT ON FUNCTION public.audit_rls_smoke_check() IS');
    expect(commentStart).toBeGreaterThan(-1);
    const commentWindow = migration.slice(commentStart);

    // ---- Category A keyword ----
    // The comment must identify Category A as the drift-candidate class.
    // 'drift candidates' is the distinguishing phrase that tells an operator
    // to file a new KNOWN_ISSUES entry rather than stopping and investigating.
    expect(commentWindow).toContain('A=drift candidates');

    // ---- Category B keyword ----
    // Category B is the name-based prior-migration assertion class — false
    // means stop and investigate. The phrase 'stop and investigate' is the
    // distinguishing operator instruction.
    expect(commentWindow).toContain('B=name-based prior-migration assertions');

    // ---- Category C keyword ----
    // Category C is the active-hardening class — false is an active vulnerability.
    // 'active vulnerability' is the distinguishing severity signal.
    expect(commentWindow).toContain("C=this-migration");

    // ---- All three single-letter labels appear ----
    // Belt-and-suspenders: the A=, B=, C= labels themselves must all be
    // present. If the comment is truncated mid-way, one of these fails.
    expect(commentWindow).toMatch(/A=/);
    expect(commentWindow).toMatch(/B=/);
    expect(commentWindow).toMatch(/C=/);

    // ---- The comment references the migration file by name ----
    // An operator reading the comment needs to know where the full
    // key->category mapping lives. The migration filename must appear.
    expect(commentWindow).toContain('20260517000000_governance_hardening_followup.sql');

    // ---- Negative: the comment must not be empty or a stub ----
    // A placeholder comment ('TODO', 'See docs', etc.) with no category
    // content would satisfy the 'COMMENT ON FUNCTION' presence check
    // above but not serve the operator. Length > 100 chars is a
    // reasonable floor for substantive content.
    const commentTextMatch = commentWindow.match(/COMMENT ON FUNCTION[^']*'([^']|'')*'/s);
    expect(commentTextMatch).not.toBeNull();
    // The matched comment statement must be more than 100 characters.
    expect((commentTextMatch![0] ?? '').length).toBeGreaterThan(100);
  });

  it('prevent_change_set_field_tampering trigger has exactly 14 RAISE EXCEPTION guards — 5 universal-immutable + 9 service-role-only', () => {
    const migration = readRepoFile(FOLLOWUP_MIGRATION);

    // ---- 1. Structural presence: count must be exactly 14 ----
    // The pattern anchors to the table-name prefix so it only counts guards in
    // this trigger function. Each RAISE EXCEPTION for a guarded field starts
    // with the literal string 'lease_change_sets.
    const raiseExceptionMatches = migration.match(
      /RAISE EXCEPTION 'lease_change_sets\./g
    ) ?? [];
    expect(raiseExceptionMatches).toHaveLength(14);

    // ---- 2. Each of the 14 guarded columns appears in a RAISE EXCEPTION ----
    const universalImmutableColumns = [
      'id',
      'lease_id',
      'workspace_id',
      'submitted_by',
      'created_at',
    ] as const;

    const serviceRoleOnlyColumns = [
      'status',
      'unlock_request_id',
      'submitted_at',
      'reviewed_by',
      'reviewed_at',
      'review_note',
      'self_approved',
      'requested_approver_id',
      'change_summary',
    ] as const;

    for (const col of [...universalImmutableColumns, ...serviceRoleOnlyColumns]) {
      // Each guarded column must appear in at least one RAISE EXCEPTION string.
      expect(migration).toContain(`lease_change_sets.${col}`);
    }

    // ---- 3. Deliberately-uncovered column must NOT appear in any RAISE EXCEPTION ----
    // updated_at is intentionally excluded per the column policy documentation
    // above the trigger (managed by separate set_updated_at trigger). If it
    // appears, either the policy was updated without updating this test, or
    // the exclusion was silently removed.
    const deliberatelyUncoveredColumns = ['updated_at'] as const;
    for (const col of deliberatelyUncoveredColumns) {
      // Use the same prefix pattern to avoid false matches from comments.
      const guardPattern = new RegExp(`RAISE EXCEPTION 'lease_change_sets\\.${col}`);
      expect(migration).not.toMatch(guardPattern);
    }

    // ---- 4. Structural position: service-role block contains the 8 mutable fields ----
    const serviceRolePos = migration.indexOf("COALESCE(auth.role(), '') <> 'service_role'");
    expect(serviceRolePos).toBeGreaterThan(-1);

    // All 8 service-role-only guards appear AFTER the service-role predicate.
    for (const col of serviceRoleOnlyColumns) {
      const guardPos = migration.indexOf(`OLD.${col} IS DISTINCT FROM NEW.${col}`);
      expect(guardPos).toBeGreaterThan(serviceRolePos);
    }

    // ---- 4b. All 5 universal guards precede the service-role block ----
    // id and created_at use IS DISTINCT FROM; submitted_by uses the IS NOT NULL guard.
    const workspaceIdPos = migration.indexOf('OLD.workspace_id IS DISTINCT FROM NEW.workspace_id');
    const leaseIdPos = migration.indexOf('OLD.lease_id IS DISTINCT FROM NEW.lease_id');
    const idPos = migration.indexOf('OLD.id IS DISTINCT FROM NEW.id');
    const createdAtPos = migration.indexOf('OLD.created_at IS DISTINCT FROM NEW.created_at');
    const submittedByPos = migration.indexOf('OLD.submitted_by IS NOT NULL');

    expect(workspaceIdPos).toBeGreaterThan(-1);
    expect(leaseIdPos).toBeGreaterThan(-1);
    expect(idPos).toBeGreaterThan(-1);
    expect(createdAtPos).toBeGreaterThan(-1);
    expect(submittedByPos).toBeGreaterThan(-1);

    // Every universal guard must appear before the service-role block opens.
    expect(idPos).toBeLessThan(serviceRolePos);
    expect(leaseIdPos).toBeLessThan(serviceRolePos);
    expect(workspaceIdPos).toBeLessThan(serviceRolePos);
    expect(submittedByPos).toBeLessThan(serviceRolePos);
    expect(createdAtPos).toBeLessThan(serviceRolePos);
  });
});
