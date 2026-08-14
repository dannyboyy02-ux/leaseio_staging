-- #197 RESOLVED (owner decision 2026-08-14): firm staff CAN create leases in
-- child workspaces.
--
-- Wave 5's INSERT tightening (20260814170000_leases_insert_requires_editor)
-- gated on has_workspace_permission(..., 'editor'), which has no firm branch —
-- deliberately matching the UPDATE policy's stance at the time, with the firm
-- question explicitly deferred to the owner (#197). Decision: firm-derived
-- staff (firm_admin -> effective admin, firm_member -> effective editor, per
-- src/lib/firmAccess.ts) are intake-capable in child workspaces. Both firm
-- roles map to editor-or-better, so the firm branch is role-agnostic within
-- firm_members and mirrors is_workspace_member()'s Phase-9 firm arm EXACTLY —
-- including the restrict_firm_access opt-out.
--
-- The three documented-for-lockstep gates move together in this change:
--   1. this policy (DB layer),
--   2. _shared/role_gate.ts callerCanProcessLeases (process_lease/retry_lease),
--   3. the client intake predicates (Dashboard/Leases/ImportHistory).
--
-- Scope note (deliberate): the UPDATE policy is NOT widened. Firm staff can
-- create leases and edit their OWN (the user_id arm); editing colleagues'
-- leases still requires direct workspace membership — the same stance the
-- UPDATE gate has had since the baseline. Viewers remain fully excluded.
--
-- Direct-viewer override (lockstep with role_gate.ts): a user who is BOTH
-- firm staff AND a direct workspace_members VIEWER keeps the viewer's
-- read-only contract — the explicit per-workspace assignment out-ranks the
-- firm-derived allowance. Without this arm, RLS would accept a draft INSERT
-- that process_lease then refuses (the quiet-mismatch class Wave 5 closed).
-- The NOT EXISTS evaluates correctly under workspace_members RLS because its
-- SELECT policy always exposes the caller's own row (user_id = auth.uid()).
--
-- Idempotent: DROP IF EXISTS then CREATE.

DROP POLICY IF EXISTS "leases_insert_own_editor_plus" ON "public"."leases";

CREATE POLICY "leases_insert_own_editor_plus" ON "public"."leases"
  FOR INSERT
  WITH CHECK (
    ("auth"."uid"() = "user_id")
    AND (
      ("workspace_id" IS NULL)
      OR "public"."has_workspace_permission"("workspace_id", "auth"."uid"(), 'editor'::"public"."workspace_role")
      -- #197: firm membership grants intake in child workspaces UNLESS the
      -- child opted out — the workspace arm is_workspace_member() uses, plus
      -- the direct-viewer override (see header).
      OR EXISTS (
        SELECT 1 FROM "public"."workspaces" "w"
        WHERE "w"."id" = "workspace_id"
          AND "w"."firm_id" IS NOT NULL
          AND "w"."restrict_firm_access" = false
          AND "public"."is_firm_member"("w"."firm_id", "auth"."uid"())
          AND NOT EXISTS (
            SELECT 1 FROM "public"."workspace_members" "m"
            WHERE "m"."workspace_id" = "w"."id"
              AND "m"."user_id" = "auth"."uid"()
              AND "m"."role" = 'viewer'
          )
      )
    )
  );
