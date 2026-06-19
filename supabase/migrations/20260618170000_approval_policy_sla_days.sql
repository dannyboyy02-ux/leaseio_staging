-- KNOWN_ISSUES #111 C6: per-policy approval SLA.
-- approval_policies gains an optional sla_days. When NULL, callers fall back to
-- the default of 7 days (the prior hardcoded ChainStepBadges "red ≥7" /
-- detect-stuck-chains STUCK_THRESHOLD_DAYS). This drives the SLA-aware aging
-- badge now surfaced to the BLOCKING APPROVER in ApprovalQueue (previously only
-- the admin ExceptionsDashboard saw a step aging).
--
-- Nullable + fall-back-in-logic (not a column DEFAULT) so existing policies need
-- no backfill — they implicitly use 7 until an admin sets a value. Idempotent.

ALTER TABLE public.approval_policies
  ADD COLUMN IF NOT EXISTS sla_days integer;

DO $$
BEGIN
  ALTER TABLE public.approval_policies
    ADD CONSTRAINT approval_policies_sla_days_positive
    CHECK (sla_days IS NULL OR sla_days > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.approval_policies.sla_days IS
  'KNOWN_ISSUES #111 C6: per-policy approval SLA in days. NULL → default 7 in logic (DEFAULT_SLA_DAYS). Drives the over-SLA aging badge surfaced to the blocking approver in ApprovalQueue. 2026-06-18.';
