-- Wave 5 "honest walls" (Decision 2026-08-14): the Viewer role becomes truly
-- read-only at the database layer.
--
-- WHY: the baseline INSERT policy ("Users can insert leases") admitted ANY
-- workspace member — is_workspace_member() — so a viewer could create leases
-- (and, via process_lease, burn paid Opus abstractions) despite the invite
-- dialog's "read-only access" promise (Wave-4 persona sweep, HIGH). The UPDATE
-- policy (leases_update_own_or_workspace_editor) already gates on
-- has_workspace_permission(..., 'editor'); INSERT now matches it, so the two
-- write paths finally agree about what a viewer is.
--
-- SEMANTICS (identical shape to the UPDATE policy's gate):
--   * inserting user must be the row's user_id (unchanged), AND
--   * workspace_id IS NULL (legacy personal lease, unchanged), OR
--   * has_workspace_permission(workspace_id, auth.uid(), 'editor') —
--     workspace owner, or a member with role admin/editor. Viewer fails.
--
-- Deliberate consequences, matching the existing UPDATE gate exactly:
--   * FIRM-DERIVED access (firm staff with no direct workspace_members row)
--     does NOT grant insert — has_workspace_permission has no firm branch,
--     same as it already doesn't for UPDATE. Server-side lockstep:
--     _shared/role_gate.ts takes the identical stance in process_lease /
--     retry_lease. If firm-staff intake is ever wanted, all of these move
--     together.
--   * service_role bypasses RLS as always (process_lease creates leases with
--     the admin client; its own role gate covers the caller).
--
-- Idempotent: DROP IF EXISTS both the old and new names, then CREATE.

DROP POLICY IF EXISTS "Users can insert leases" ON "public"."leases";
DROP POLICY IF EXISTS "leases_insert_own_editor_plus" ON "public"."leases";

CREATE POLICY "leases_insert_own_editor_plus" ON "public"."leases"
  FOR INSERT
  WITH CHECK (
    ("auth"."uid"() = "user_id")
    AND (
      ("workspace_id" IS NULL)
      OR "public"."has_workspace_permission"("workspace_id", "auth"."uid"(), 'editor'::"public"."workspace_role")
    )
  );
