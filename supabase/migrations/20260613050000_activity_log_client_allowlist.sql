-- lease_activity_log client-insert allowlist (KNOWN_ISSUES #90; the activity-
-- type half split from #78).
--
-- BEFORE (live): the permissive INSERT policy "Users can create activity
-- entries" let any workspace member insert a row with ANY of the ~100
-- constraint activity_types and user_id NULL (system-attributed). The sharp
-- edge (#78 addendum): a member-forged 'policy_assignee_validation_failed' /
-- 'stuck_chain_detected' row (NULL = system) renders as an exception alert in
-- ExceptionsDashboard and can induce an admin to reassign/override a healthy
-- chain step — forged audit history that drives admin action.
--
-- FIX: constrain authenticated client INSERTs to the activity_types that
-- clients actually emit (the 19 below — VERIFIED by enumerating every
-- `lease_activity_log.insert(...)` site in src/ on 2026-06-13). Every other
-- type (chain_step_*, the dashboard-alert types, report_*, tier2_*, OOO/
-- delegate, etc.) is written EXCLUSIVELY by edge functions, which run as
-- service_role and BYPASS RLS — so this policy does not touch them; it only
-- stops a browser client from forging them.
--
-- user_id is left flexible (auth.uid() OR NULL): legitimate system comments
-- are inserted client-side with user_id NULL (leaseNotifications.ts,
-- FinancialReview, ApprovalQueue), so dropping NULL would break them. The
-- allowlist alone closes the documented HIGH (the alert types are no longer
-- client-insertable at all). Residual (accepted, lower-stakes): a member can
-- still insert an ALLOWLISTED type with NULL attribution (e.g. a forged
-- system 'comment'/'status_change') — tracked as a follow-up if attribution
-- tightening (NULL only for 'comment') is later desired.
--
-- Recreates the policy preserving its original shape (PERMISSIVE, FOR INSERT,
-- role public, the user_id + workspace-membership predicate verbatim) and
-- AND-ing the allowlist. The Vault V1 RESTRICTIVE "live workspace required for
-- insert" policy ANDs on top, unchanged.

DROP POLICY IF EXISTS "Users can create activity entries" ON public.lease_activity_log;

CREATE POLICY "Users can create activity entries"
  ON public.lease_activity_log
  FOR INSERT
  TO public
  WITH CHECK (
    ((user_id = auth.uid()) OR (user_id IS NULL))
    AND (activity_type = ANY (ARRAY[
      'created',
      'status_change',
      'approval',
      'rejection',
      'send_back',
      'pause',
      'comment',
      'nudge_sent',
      'document_upload',
      'document_deleted',
      'risk_added',
      'risk_dismissed',
      'asc842_inputs_updated',
      'discount_rate_set',
      'discount_rate_cleared',
      'amendment_archived',
      'lease_archived',
      'lease_restored',
      'chain_violation_resolved'
    ]::text[]))
    AND (EXISTS (
      SELECT 1
      FROM leases l
      WHERE ((l.id = lease_activity_log.lease_id)
        AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))
    ))
  );

COMMENT ON POLICY "Users can create activity entries" ON public.lease_activity_log IS
  'KNOWN_ISSUES #90: authenticated client INSERTs are restricted to the 19 client-emitted activity_types (verified against src/ writers 2026-06-13); all service-role-only types (chain_step_*, dashboard alerts, report_*, tier2_*, etc.) are not client-insertable. Edge functions bypass RLS. user_id stays flexible (NULL allowed for system comments). Re-derive the allowlist when a NEW client-side lease_activity_log writer is added.';
