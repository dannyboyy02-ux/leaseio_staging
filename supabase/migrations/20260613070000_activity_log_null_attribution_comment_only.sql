-- lease_activity_log NULL-attribution tightening (KNOWN_ISSUES #90-NULL; the
-- follow-up noted in #90's resolution stamp).
--
-- BEFORE (migration 20260613050000, live): the recreated INSERT policy
-- "Users can create activity entries" constrained the activity_type to a
-- 19-value client allowlist but left user_id flexible —
--   ((user_id = auth.uid()) OR (user_id IS NULL))
-- so an authenticated workspace member could still insert an ALLOWLISTED type
-- with user_id NULL (system attribution): e.g. a forged system-attributed
-- 'status_change' / 'approval' / 'lease_archived' row that reads as if LeaseIO
-- itself wrote it. The #90 allowlist closed the HIGH (the dashboard-alert types
-- are no longer client-insertable at all); this closes the accepted residual:
-- forgeable NULL attribution on the allowlisted types.
--
-- FIX: NULL user_id is legitimate for exactly ONE client-emitted type —
-- 'comment' — which is inserted with user_id NULL by design when the row is a
-- system/notification comment (leaseNotifications.ts, FinancialReview,
-- ApprovalQueue, LeaseReview comment). Every other client-emitted type carries
-- a real actor. So allow NULL only for 'comment'; require user_id = auth.uid()
-- for all other allowlisted types.
--
-- VERIFIED SAFE against every client lease_activity_log writer (src/, 2026-06-13):
--   * Literal `user_id: null` sites are ALL activity_type 'comment'
--     (leaseNotifications.ts:82,118; FinancialReview.tsx:248,290,302;
--     ApprovalQueue.tsx:912,961) — still valid under the new clause. LeaseReview
--     :770 is also a 'comment' (uses `user?.id || null`) — permitted regardless.
--   * The NON-comment nullable sites pass a DEFENSIVE `?? null` / `|| null`, not
--     a literal null: LeaseReview status_change :1661 + approval :1744; Leases
--     lease_archived :224 + lease_restored :252 (from useApp() `user`); and
--     AddRiskDialog :243 + LeaseReviewSections :539 + LockedLeaseDetail :264
--     (risk_added/risk_dismissed, from a fresh supabase.auth.getUser() in-handler).
--     (List illustrative, not exhaustive — the reasoning generalizes to any such
--     site.) All execute only inside authenticated, member-gated flows; the
--     policy's EXISTS workspace-membership check already requires a non-null
--     auth.uid() for the row to insert at all, so when these succeed today
--     user_id is the real UID, never null — tightening breaks no currently-
--     succeeding flow. Each treats the audit insert as best-effort (log-on-error,
--     no throw), so even the impossible no-session case degrades to a skipped
--     (correctly unattributable) row, not a broken user action.
--
-- Recreates the policy preserving its original shape (PERMISSIVE, FOR INSERT,
-- role public, the 19-type allowlist + workspace-membership EXISTS predicate
-- verbatim) and ONLY tightens the user_id clause. The Vault V1 RESTRICTIVE
-- "live workspace required for insert" policy ANDs on top, unchanged.

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
  'KNOWN_ISSUES #90 + #90-NULL: authenticated client INSERTs are restricted to the 19 client-emitted activity_types (verified against src/ writers 2026-06-13); all service-role-only types (chain_step_*, dashboard alerts, report_*, tier2_*, etc.) are not client-insertable (edge functions bypass RLS). user_id NULL is permitted ONLY for activity_type=''comment'' (legit system/notification comments); every other type must carry user_id = auth.uid(). Re-derive the allowlist + re-check the NULL-comment carve-out when a NEW client-side lease_activity_log writer is added.';
