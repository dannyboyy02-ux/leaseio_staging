-- KNOWN_ISSUES #90 allowlist extension.
--
-- The dashboard EscalationReviewPanel is a NEW client-side lease_activity_log
-- writer (activity_type 'escalation_review_resolved', attributing a human's
-- confirmation of a lease's escalation terms). The escalation columns are not
-- governed, so the browser UPDATE succeeds — but the accompanying audit INSERT
-- would be silently rejected (42501) by the "Users can create activity entries"
-- INSERT policy, whose allowlist did not include the new type.
--
-- Recreate the policy from its LATEST definition (20260613070000, the #90-NULL
-- hardening) + the one new value. The tightened NULL-attribution carve-out
-- (user_id NULL only for 'comment') and the workspace-membership guard are
-- reproduced verbatim — do NOT revert to the pre-#90-NULL loose clause.
DROP POLICY IF EXISTS "Users can create activity entries" ON public.lease_activity_log;

CREATE POLICY "Users can create activity entries"
  ON public.lease_activity_log
  FOR INSERT
  TO public
  WITH CHECK (
    ((user_id = auth.uid()) OR (user_id IS NULL AND activity_type = 'comment'))
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
      'chain_violation_resolved',
      'escalation_review_resolved'
    ]::text[]))
    AND (EXISTS (
      SELECT 1
      FROM leases l
      WHERE ((l.id = lease_activity_log.lease_id)
        AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))
    ))
  );

COMMENT ON POLICY "Users can create activity entries" ON public.lease_activity_log IS
  'KNOWN_ISSUES #90 + #90-NULL: authenticated client INSERTs are restricted to the 20 client-emitted activity_types (escalation_review_resolved added 2026-07-17 for the dashboard EscalationReviewPanel); all service-role-only types (chain_step_*, dashboard alerts, report_*, tier2_*, etc.) are not client-insertable (edge functions bypass RLS). user_id NULL is permitted ONLY for activity_type=''comment''; every other type must carry user_id = auth.uid(). Re-derive the allowlist + re-check the NULL-comment carve-out when a NEW client-side lease_activity_log writer is added.';
