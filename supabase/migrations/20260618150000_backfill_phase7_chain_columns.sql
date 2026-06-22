-- KNOWN_ISSUES #111 C1 (audit Class 3): backfill the Phase-7 denormalized
-- columns on lease_approval_chain for chains created while the stale
-- (pre-Phase-7) resolve-approval-chain was deployed (the deferred #84 redeploy).
-- Those chains have NULL effective_assignee_user_id / assignee_resolution_source
-- / pending_since, so process-delegate-timers + detect-stuck-chains silently
-- skip them — no policy-timeout auto-delegate, no stuck detection.
--
-- SHIPS WITH THE resolve-approval-chain REDEPLOY. The repo source already sets
-- these columns correctly at creation (index.ts:958-985); the redeploy was
-- ezbr-deferred per PHASE_7_BUILD_SPEC.md A4. This migration repairs EXISTING
-- rows; the redeploy fixes NEW chains. Idempotent (every UPDATE guards on the
-- target column IS NULL) — safe to re-run and safe before or after the redeploy.
--
-- PIVOT FROM THE A4 NOTE'S ONE-LINER (deliberate — it would create bugs against
-- the live schema, verified 2026-06-18):
--   UPDATE ... SET pending_since = COALESCE(pending_since, status_changed_at)
--   WHERE status = 'pending';
--   (1) lease_approval_chain has NO status_changed_at column → that statement
--       would ERROR (only `leases` has status_changed_at).
--   (2) It sets pending_since on EVERY pending row. But resolve-approval-chain
--       sets pending_since ONLY on the first-active required concept step
--       (index.ts:979-984); later concept steps and ALL signator steps are
--       inserted status='pending' with pending_since=NULL and get it later, as
--       prior steps complete. Setting pending_since on those not-yet-active
--       steps would make detect-stuck-chains raise FALSE stuck alerts and
--       process-delegate-timers activate delegates EARLY.
-- This migration instead mirrors creation: pending_since lands only on the
-- FRONTIER active required step(s) per lease (the earliest unfinished required
-- step, ordered concept<signator then by step_order, parallel groups co-active).
--
-- pending_since timestamp: per-step activation time isn't recoverable (no
-- per-row acted_at), so we use the lease's status_changed_at (when it entered
-- its current stage ≈ when the frontier step became active), falling back to the
-- chain row's created_at. This approximation errs toward making a step look
-- slightly older → toward SURFACING a stuck chain, the safe direction for an
-- audit-defensibility fix. OPERATOR NOTE: on the first detect-stuck-chains /
-- process-delegate-timers run after this backfill, any genuinely-aged chain will
-- (correctly) flag stuck / activate an elapsed delegate timer at once — expect a
-- one-time burst proportional to the backlog.

-- 1. Denormalized assignee mirror — safe on every pending row; never clobber an
--    effective_assignee that was already set (e.g. a delegation on a partially-
--    migrated chain). For role-based rows approver_user_id is NULL → effective
--    stays NULL and authz/queue fall back to the role, as designed.
UPDATE public.lease_approval_chain AS lac
SET
  effective_assignee_user_id = lac.approver_user_id,
  assignee_resolution_source = CASE
    WHEN lac.approver_user_id IS NOT NULL THEN 'policy_user'
    ELSE 'policy_role'
  END
WHERE lac.status = 'pending'
  AND lac.effective_assignee_user_id IS NULL
  AND lac.assignee_resolution_source IS NULL;

-- 2. pending_since on the FRONTIER active required step only. A pending required
--    row is "active" iff no earlier still-blocking required row exists for the
--    same lease — earlier = concept before signator, then lower step_order.
--    "Still-blocking" = status IN ('pending','sent_back'); approved/skipped/
--    superseded/rejected no longer block. Parallel steps (equal stage+step_order)
--    are co-active (neither is strictly earlier).
UPDATE public.lease_approval_chain AS lac
SET pending_since = COALESCE(
  (SELECT l.status_changed_at FROM public.leases l WHERE l.id = lac.lease_id),
  lac.created_at
)
WHERE lac.status = 'pending'
  AND lac.is_required IS TRUE
  AND lac.pending_since IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.lease_approval_chain earlier
    WHERE earlier.lease_id = lac.lease_id
      AND earlier.is_required IS TRUE
      AND earlier.status IN ('pending', 'sent_back')
      AND (
        (CASE earlier.stage WHEN 'concept' THEN 0 ELSE 1 END)
          < (CASE lac.stage WHEN 'concept' THEN 0 ELSE 1 END)
        OR (
          (CASE earlier.stage WHEN 'concept' THEN 0 ELSE 1 END)
            = (CASE lac.stage WHEN 'concept' THEN 0 ELSE 1 END)
          AND earlier.step_order < lac.step_order
        )
      )
  );
