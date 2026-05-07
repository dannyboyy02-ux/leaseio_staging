-- ─────────────────────────────────────────────────────────────────────────
-- Lease-level ASC 842 inputs — full coverage for measurement,
-- classification, term assessment, and disclosure
-- ─────────────────────────────────────────────────────────────────────────
--
-- For ASC 842 reports to be useful (vs. a vanity artifact), every field
-- that materially affects measurement (ROU asset, lease liability),
-- classification (operating vs. finance), or required disclosure must
-- be capturable per-lease. The AI extraction pipeline does not surface
-- most of these today; this table is the structured store for human-
-- captured / human-confirmed values.
--
-- Design choices:
--   - Separate table (not 20+ columns on leases) to keep concerns
--     isolated and the leases table narrow.
--   - One row per lease (UNIQUE on lease_id; FK CASCADE on delete).
--   - All numeric/boolean fields nullable. NULL = "not yet captured"
--     (distinct from 0/false which means "captured as zero/false").
--   - Per-group `*_basis` text fields capture WHY the value was set
--     that way — audit-defensibility for downstream readers.
--   - last_updated_at + last_updated_by for last-write audit.
--   - workspace_id denormalized for RLS scoping.
--
-- Field groups:
--   1. Right-of-Use Asset Adjustments
--      (TI allowance, initial direct costs, prepaid rent,
--       lease incentives received)
--   2. Lease Liability Inputs
--      (residual value guarantee, purchase option price + RC flag,
--       termination penalty if RC to exercise)
--   3. Classification Criteria (5 ASC 842-10-25-2 tests)
--   4. Term Assessment
--      (renewal options RC term-extension, short-term election)
--   5. Disclosure / Variable Payments
--      (variable payments description, sublease info)

CREATE TABLE IF NOT EXISTS public.lease_asc842_inputs (
  id                                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                                    uuid NOT NULL UNIQUE REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- ─── Right-of-Use Asset Adjustments ─────────────────────────────────
  -- TI allowance: lessor cash paid to lessee to fit out the space.
  -- Reduces the ROU asset under ASC 842-20-25-1.
  tenant_improvement_allowance               numeric(14,2),
  tenant_improvement_allowance_basis         text,
  -- IDC: incremental costs the lessee would not have incurred if the
  -- lease had not been obtained (commissions, legal, etc.).
  -- Increases the ROU asset under ASC 842-20-30-5.
  initial_direct_costs                       numeric(14,2),
  initial_direct_costs_basis                 text,
  -- Prepaid rent paid at or before commencement (added to ROU).
  prepaid_rent                               numeric(14,2),
  prepaid_rent_basis                         text,
  -- Other incentives received from lessor (free rent periods, moving
  -- allowances, etc.). Reduces ROU.
  lease_incentives_received                  numeric(14,2),
  lease_incentives_received_basis            text,

  -- ─── Lease Liability Inputs ─────────────────────────────────────────
  -- Residual value guarantee: the maximum amount the lessee may be
  -- required to pay the lessor at the end of the lease for residual
  -- value of the asset. Included in lease liability (finance leases
  -- typically; operating leases include if RC of being paid).
  residual_value_guarantee                   numeric(14,2),
  residual_value_guarantee_basis             text,
  -- Purchase option: if reasonably certain to be exercised, the option
  -- price is added to the lease liability under ASC 842-10-30-5.
  purchase_option_present                    boolean,
  purchase_option_price                      numeric(14,2),
  purchase_option_reasonably_certain         boolean,
  purchase_option_basis                      text,
  -- Termination penalty payable if lessee terminates early — included
  -- in the lease liability if RC the lessee will terminate.
  termination_penalty_amount                 numeric(14,2),
  termination_penalty_reasonably_certain     boolean,
  termination_penalty_basis                  text,

  -- ─── Classification Criteria (ASC 842-10-25-2 — the 5 tests) ────────
  -- Any one of these met → finance lease classification.
  ownership_transfers_at_end                 boolean,
  bargain_purchase_option                    boolean,
  -- Major part of remaining economic life (commonly ≥75%)
  major_part_economic_life                   boolean,
  major_part_economic_life_pct               numeric(5,2),
  -- PV ≥ substantially all of fair value (commonly ≥90%)
  pv_substantially_all_fair_value            boolean,
  pv_to_fair_value_pct                       numeric(5,2),
  asset_fair_value                           numeric(14,2),
  -- Specialized asset with no alternative use to the lessor
  specialized_asset_no_alt_use               boolean,
  classification_criteria_basis              text,

  -- ─── Term Assessment ───────────────────────────────────────────────
  -- Renewal options the lessee is reasonably certain to exercise add
  -- to the lease term used in PV calculation. ASC 842-10-30-1.
  renewal_options_rc_term_months             integer,
  renewal_options_rc_basis                   text,
  -- Short-term lease election (12 months or less, no purchase option
  -- RC of being exercised). Election made at lease inception, applied
  -- consistently by asset class. ASC 842-20-25-2.
  short_term_lease_election                  boolean,
  short_term_lease_election_basis            text,

  -- ─── Disclosure / Variable Payments ────────────────────────────────
  -- Variable payments not based on an index or rate are excluded from
  -- the lease liability but disclosed under ASC 842-20-50. Common
  -- examples: percentage rent, usage-based, CPI escalations after
  -- commencement.
  variable_payments_description              text,
  variable_payments_estimated_annual         numeric(14,2),
  -- Sublease income (if the lessee has subleased the asset).
  sublease_income_annual                     numeric(14,2),
  sublease_basis                             text,

  -- ─── Audit ──────────────────────────────────────────────────────────
  last_updated_at                            timestamptz NOT NULL DEFAULT now(),
  last_updated_by                            uuid REFERENCES auth.users(id),
  created_at                                 timestamptz NOT NULL DEFAULT now(),

  -- ─── Bound CHECKs ───────────────────────────────────────────────────
  CONSTRAINT asc842_inputs_amounts_non_negative CHECK (
    (tenant_improvement_allowance IS NULL OR tenant_improvement_allowance >= 0) AND
    (initial_direct_costs IS NULL OR initial_direct_costs >= 0) AND
    (prepaid_rent IS NULL OR prepaid_rent >= 0) AND
    (lease_incentives_received IS NULL OR lease_incentives_received >= 0) AND
    (residual_value_guarantee IS NULL OR residual_value_guarantee >= 0) AND
    (purchase_option_price IS NULL OR purchase_option_price >= 0) AND
    (termination_penalty_amount IS NULL OR termination_penalty_amount >= 0) AND
    (asset_fair_value IS NULL OR asset_fair_value >= 0) AND
    (variable_payments_estimated_annual IS NULL OR variable_payments_estimated_annual >= 0) AND
    (sublease_income_annual IS NULL OR sublease_income_annual >= 0)
  ),
  CONSTRAINT asc842_inputs_pct_range CHECK (
    (major_part_economic_life_pct IS NULL OR (major_part_economic_life_pct >= 0 AND major_part_economic_life_pct <= 100)) AND
    (pv_to_fair_value_pct IS NULL OR (pv_to_fair_value_pct >= 0 AND pv_to_fair_value_pct <= 100))
  ),
  CONSTRAINT asc842_inputs_renewal_term_non_negative CHECK (
    renewal_options_rc_term_months IS NULL OR renewal_options_rc_term_months >= 0
  )
);

-- Index for workspace-scoped queries (e.g., portfolio reports loading
-- all inputs in one shot).
CREATE INDEX IF NOT EXISTS idx_lease_asc842_inputs_workspace
  ON public.lease_asc842_inputs (workspace_id);

-- Trigger to bump last_updated_at on any UPDATE.
CREATE OR REPLACE FUNCTION public.lease_asc842_inputs_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.last_updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lease_asc842_inputs_updated_at_trigger ON public.lease_asc842_inputs;
CREATE TRIGGER lease_asc842_inputs_updated_at_trigger
  BEFORE UPDATE ON public.lease_asc842_inputs
  FOR EACH ROW
  EXECUTE FUNCTION public.lease_asc842_inputs_set_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────────────
ALTER TABLE public.lease_asc842_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace members read asc842 inputs" ON public.lease_asc842_inputs;
CREATE POLICY "workspace members read asc842 inputs"
  ON public.lease_asc842_inputs FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "editors and admins write asc842 inputs" ON public.lease_asc842_inputs;
CREATE POLICY "editors and admins write asc842 inputs"
  ON public.lease_asc842_inputs FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "editors and admins update asc842 inputs" ON public.lease_asc842_inputs;
CREATE POLICY "editors and admins update asc842 inputs"
  ON public.lease_asc842_inputs FOR UPDATE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

-- ─── Activity types ──────────────────────────────────────────────────
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    'status_change','approval','rejection','send_back','pause',
    'nudge_sent','document_upload','created','comment',
    'executed_uploaded','executed_terms_extracted','unlock_approved',
    'unlock_requested','change_canceled','change_set_submitted',
    'change_set_approved','change_set_rejected','change_set_self_approved',
    'risk_dismissed','risk_restored','risk_added','change_submitted',
    'change_approved','change_rejected',
    'chain_resolved','chain_step_approved','chain_step_rejected',
    'chain_step_sent_back','chain_stage_completed','chain_resolution_failed',
    'concept_stage_entered','concept_stage_completed',
    'negotiation_stage_entered','final_review_stage_entered',
    'pending_counter_signature_started','fully_executed_recorded',
    'concept_approver_escalation_requested','final_review_advanced',
    'document_uploaded_with_metadata','document_iteration_started',
    'document_version_bumped',
    'signator_attestation_recorded','execution_owner_assigned',
    'counter_signature_recorded','counter_signature_reminder_sent',
    'counter_signature_overdue_recorded',
    'signator_review_decline','execution_owner_reassigned',
    'attribute_change_detected','chain_rerouted',
    'chain_reroute_skipped_no_match','chain_violation_entered',
    'chain_violation_resolved','reroute_audit_run',
    'manual_reroute_requested','manual_reroute_approved',
    'manual_reroute_rejected',
    'voluntary_delegation_set','voluntary_delegation_revoked',
    'admin_override_executed','out_of_office_declared',
    'out_of_office_revoked','delegate_timer_activated',
    'delegate_timer_started','step_pending_started',
    'stuck_chain_detected','stuck_chain_resolved',
    'deactivated_approver_handled','chain_step_overridden',
    'chain_step_admin_reassigned',
    'report_generation_requested','report_generation_completed',
    'report_generation_failed','report_downloaded',
    'report_expired','report_deleted',
    'discount_rate_set','discount_rate_cleared',
    'asc842_inputs_updated'
  ));

COMMENT ON TABLE public.lease_asc842_inputs IS
  'Per-lease ASC 842 measurement and classification inputs. One row per lease (UNIQUE on lease_id). Captures TI/IDC, residual guarantees, purchase options, classification criteria, term assessment, and variable payments — all human-confirmed (the AI extraction pipeline does not surface most of these). NULL = not yet captured (distinct from 0/false which means captured as zero).';
