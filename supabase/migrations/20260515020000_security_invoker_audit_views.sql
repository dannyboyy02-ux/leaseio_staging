-- ============================================================
-- security_invoker_audit_views (P1-09)
-- Harden v_governance_audit_report and v_lease_verification_audit
-- against cross-tenant reads.
--
-- Per audit P1-09 in docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md:
-- both views were created without `WITH (security_invoker = true)` and
-- are owned by postgres. In Postgres, ordinary views run with the
-- OWNER's privileges, so RLS on the underlying tables
-- (lease_governance_audit, leases, workspaces, field_corrections)
-- is bypassed. Any authenticated user with a valid JWT could SELECT
-- across every workspace's audit + verification data.
--
-- Two failures compounded:
--   1. Views ran as postgres, bypassing tenant RLS.
--   2. anon AND authenticated had full DML grants (DELETE, INSERT,
--      UPDATE, TRUNCATE, REFERENCES, TRIGGER, SELECT) — wildly broader
--      than intended. The grants came from default PUBLIC privileges
--      that supabase wires through.
--
-- This migration drops + recreates both views with security_invoker,
-- and tightens grants to SELECT-only for authenticated (anon gets
-- nothing). Edge functions that read these views use the service_role
-- key, which bypasses RLS regardless of invoker setting, so
-- server-side consumers are unaffected.
--
-- Postgres 15+ required for `security_invoker`. Verified 17.6 on this
-- project.
-- ============================================================

-- ─── v_governance_audit_report ──────────────────────────────────────
DROP VIEW IF EXISTS public.v_governance_audit_report CASCADE;

CREATE VIEW public.v_governance_audit_report
WITH (security_invoker = true) AS
SELECT
  gau.id,
  gau.created_at                                              AS event_timestamp,
  gau.event_type,
  gau.workspace_id,
  gau.lease_id,
  COALESCE(l.request_title, l.filename, 'Unnamed lease')      AS lease_name,
  gau.actor_user_id,
  gau.actor_email,
  gau.related_unlock_request_id,
  gau.related_change_set_id,
  gau.field_name,
  gau.field_label,
  gau.old_value,
  gau.proposed_value,
  gau.final_value,
  gau.change_summary,
  gau.rejection_reason,
  gau.cancellation_reason
FROM  public.lease_governance_audit gau
JOIN  public.leases l ON l.id = gau.lease_id
ORDER BY gau.created_at DESC;

REVOKE ALL ON public.v_governance_audit_report FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_governance_audit_report TO authenticated;
GRANT ALL    ON public.v_governance_audit_report TO service_role;

COMMENT ON VIEW public.v_governance_audit_report IS
  'Audit-report view for governance events. Created WITH (security_invoker = true) so the caller''s RLS applies to lease_governance_audit and leases — workspace members see only their workspace''s rows. Audit P1-09.';

-- ─── v_lease_verification_audit ─────────────────────────────────────
DROP VIEW IF EXISTS public.v_lease_verification_audit CASCADE;

CREATE VIEW public.v_lease_verification_audit
WITH (security_invoker = true) AS
SELECT
  l.id AS lease_id,
  l.workspace_id,
  l.confirmed_sections,
  l.model_locked,
  l.model_locked_at,
  l.model_locked_by,
  l.lease_classification_set_at,
  l.lease_classification_set_by,
  -- Effective discount rate: per-lease override if set, else workspace default.
  -- This is the single source of truth consumers should read for the
  -- ASC 842 disclosure report's measurement input.
  COALESCE(l.discount_rate, w.discount_rate) AS discount_rate,
  l.discount_rate AS discount_rate_per_lease_override,
  w.discount_rate AS discount_rate_workspace_default,
  l.discount_rate_basis,
  l.discount_rate_set_at,
  l.discount_rate_set_by,
  l.signator_attestation,
  l.signator_approved_at,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'field_id', fc.field_name,
      'original_value', fc.original_value,
      'corrected_value', fc.corrected_value,
      'correction_type', fc.correction_type,
      'corrected_at', fc.corrected_at,
      'corrected_by', fc.corrected_by,
      'ai_confidence_at_correction', fc.ai_confidence
    ) ORDER BY fc.corrected_at)
    FROM public.field_corrections fc
    WHERE fc.lease_id = l.id),
    '[]'::jsonb
  ) AS field_corrections
FROM public.leases l
LEFT JOIN public.workspaces w ON w.id = l.workspace_id;

REVOKE ALL ON public.v_lease_verification_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_lease_verification_audit TO authenticated;
GRANT ALL    ON public.v_lease_verification_audit TO service_role;

COMMENT ON VIEW public.v_lease_verification_audit IS
  'Verification audit aggregate for ASC 842 disclosure reports. Created WITH (security_invoker = true). The discount_rate column is the EFFECTIVE rate (per-lease override if set, else workspace default). Use discount_rate_per_lease_override to detect explicit override; use discount_rate_workspace_default for the fallback value. Audit P1-09.';
