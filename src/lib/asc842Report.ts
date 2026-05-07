// ─────────────────────────────────────────────────────────────────────────
// Pure ASC 842 disclosure-report helpers — Node mirror.
//
// SYNC CONSTRAINT — DO NOT DRIFT
// This file MUST stay byte-equivalent in *behavior* with its Deno
// counterpart:
//   supabase/functions/_shared/asc842_report.ts
//
// Both files contain identical pure functions and types. This Node copy
// is imported by the frontend (single-lease report detail page,
// portfolio-period report admin page) and by vitest unit tests in
// src/lib/__tests__/asc842Report.test.ts. The Deno copy is imported by
// the Phase 8 edge functions (generate-lease-report,
// generate-portfolio-report).
//
// When you change one, change the other in the same commit. No imports
// allowed in either file (no React, no Supabase, no Deno-only or
// Node-only modules) — only language-level types and logic.
//
// PHASE 8 SCOPE
// These helpers compose the structured disclosure report from already-
// loaded inputs. They DO NOT load anything: the edge function loads the
// lease, rent_schedules, field_corrections, and verification audit view,
// shapes them into ReportInputs, and passes the inputs in. The pure file
// emits sections + JSON; the PDF renderer at
// src/lib/reports/leaseDisclosurePdf.tsx consumes the sections.
//
// JSON SCHEMA STABILITY
// buildLeaseDisclosureJson and buildPortfolioPeriodReport produce the
// LeaseIO Disclosure JSON Schema. The schema_version constant defined
// here is the contract surface for downstream consumers (CPAs, AI tools,
// ERPs). Backward-incompatible changes require a major bump and a
// corresponding update to docs/JSON_REPORT_SCHEMA.md.
// ─────────────────────────────────────────────────────────────────────────

export const REPORT_SCHEMA_VERSION = '1.0.0';

export const LIABILITY_DISCLAIMER =
  'This report contains structured lease data extracted, verified, and audited inside LeaseIO. It is NOT a financial statement and does not constitute accounting, legal, or tax advice. The customer is solely responsible for using this data correctly in their accounting, reporting, and disclosures. LeaseIO produces structured data; the customer (or their CPA) produces the financial statement.';

export const NOT_A_FINANCIAL_STATEMENT_BANNER =
  'LeaseIO Data Report — Not a Financial Statement';

// ─── Domain types ───────────────────────────────────────────────────────

export type LeaseClassification = 'operating' | 'finance' | 'pending';

export type RentPeriod = {
  period_start: string; // ISO date
  period_end: string; // ISO date
  monthly_amount: number;
  annual_amount: number;
  notes: string | null;
};

export type Citation = {
  snippet: string;
  page: number;
};

export type EscalationClause = {
  type: string | null; // 'fixed_percent' | 'cpi' | 'fixed_amount' | 'stepped' | 'none' | null
  rate: number | null;
  notes: string | null;
};

export type RenewalOption = {
  option_term_months: number | null;
  notice_required_days: number | null;
  notes: string | null;
};

export type TerminationClause = {
  early_termination_allowed: boolean | null;
  notice_days: number | null;
  penalty_amount: number | null;
  notes: string | null;
};

export type VerificationAuditEntry = {
  field_id: string;
  original_value: string | null;
  corrected_value: string | null;
  correction_type:
    | 'add_missing'
    | 'delete_wrong'
    | 'edit'
    | 'verified_unchanged';
  corrected_at: string;
  corrected_by_user_label: string;
  ai_confidence_at_correction: number | null;
};

// Per-lease ASC 842 inputs that materially affect measurement,
// classification, term assessment, and required disclosures. NULL on
// any field means "not captured" — distinct from 0/false ("captured as
// zero/false"). Sourced from public.lease_asc842_inputs.
export type Asc842Inputs = {
  // Right-of-Use Asset Adjustments
  tenant_improvement_allowance: number | null;
  tenant_improvement_allowance_basis: string | null;
  initial_direct_costs: number | null;
  initial_direct_costs_basis: string | null;
  prepaid_rent: number | null;
  prepaid_rent_basis: string | null;
  lease_incentives_received: number | null;
  lease_incentives_received_basis: string | null;
  // Lease Liability Inputs
  residual_value_guarantee: number | null;
  residual_value_guarantee_basis: string | null;
  purchase_option_present: boolean | null;
  purchase_option_price: number | null;
  purchase_option_reasonably_certain: boolean | null;
  purchase_option_basis: string | null;
  termination_penalty_amount: number | null;
  termination_penalty_reasonably_certain: boolean | null;
  termination_penalty_basis: string | null;
  // Classification Criteria (ASC 842-10-25-2 — the 5 finance-lease tests)
  ownership_transfers_at_end: boolean | null;
  bargain_purchase_option: boolean | null;
  major_part_economic_life: boolean | null;
  major_part_economic_life_pct: number | null;
  pv_substantially_all_fair_value: boolean | null;
  pv_to_fair_value_pct: number | null;
  asset_fair_value: number | null;
  specialized_asset_no_alt_use: boolean | null;
  classification_criteria_basis: string | null;
  // Term Assessment
  renewal_options_rc_term_months: number | null;
  renewal_options_rc_basis: string | null;
  short_term_lease_election: boolean | null;
  short_term_lease_election_basis: string | null;
  // Disclosure / Variable Payments
  variable_payments_description: string | null;
  variable_payments_estimated_annual: number | null;
  sublease_income_annual: number | null;
  sublease_basis: string | null;
  // Audit
  last_updated_at: string | null;
  last_updated_by_label: string | null;
};

export type ReportInputs = {
  // Identity
  lease_id: string;
  workspace_id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  property_address: string | null;
  asset_type: string | null;
  // Lifecycle dates
  execution_date: string | null;
  commencement_date: string | null;
  rent_commencement_date: string | null;
  expiration_date: string | null;
  term_months: number | null;
  // Classification
  lease_classification: LeaseClassification;
  classification_set_at: string | null;
  classification_set_by_user_label: string | null;
  // Financial
  discount_rate: number; // percentage (e.g., 5.5)
  monthly_payment: number | null;
  rent_schedule: RentPeriod[];
  security_deposit: number | null;
  // Computed (precomputed from existing leases columns or
  // calculateLease() in src/lib/leaseCalculations.ts)
  pv_liability: number | null;
  total_commitment: number | null;
  straight_line_monthly_expense: number | null;
  cash_pl_delta: number | null;
  // Key terms
  escalation_clause: EscalationClause | null;
  renewal_options: RenewalOption[];
  termination_clause: TerminationClause | null;
  // Verification trail
  verification_audit: VerificationAuditEntry[];
  signator_attestation: string | null;
  signator_approved_at: string | null;
  model_locked_at: string | null;
  model_locked_by_user_label: string | null;
  // Citations — keyed by field_id
  field_citations: Record<string, Citation>;
  // Per-lease ASC 842 inputs (TI, IDC, RVG, classification criteria,
  // term assessment, disclosure items). Null when no asc842_inputs row
  // exists for the lease yet — preparer notes will flag this.
  asc842_inputs: Asc842Inputs | null;
};

// ─── Section types ──────────────────────────────────────────────────────

export type IdentificationField = {
  field_id: string;
  label: string;
  value: string | null;
  citation: Citation | null;
};

export type IdentificationSection = {
  fields: IdentificationField[];
};

export type PaymentScheduleSection = {
  periods: RentPeriod[];
  total_periods: number;
  total_cash_commitment: number | null;
  has_escalations: boolean;
  citation: Citation | null;
};

export type Asc842InputsSection = {
  classification: LeaseClassification;
  classification_set_at: string | null;
  classification_set_by: string | null;
  discount_rate_percent: number;
  pv_liability: number | null;
  total_commitment: number | null;
  straight_line_monthly_expense: number | null;
  cash_pl_delta: number | null;
  term_months: number | null;
  commencement_date: string | null;
  expiration_date: string | null;
  // Per-lease ASC 842 inputs surfaced verbatim. Null when no row.
  per_lease_inputs: Asc842Inputs | null;
};

export type KeyTermsSection = {
  security_deposit: number | null;
  security_deposit_citation: Citation | null;
  rent_commencement_date: string | null;
  execution_date: string | null;
  asset_type: string | null;
  escalation_clause: EscalationClause | null;
  escalation_citation: Citation | null;
  renewal_options: RenewalOption[];
  renewal_citation: Citation | null;
  termination_clause: TerminationClause | null;
  termination_citation: Citation | null;
};

export type PreparerFlagSeverity = 'low' | 'medium' | 'high';

export type PreparerFlag = {
  severity: PreparerFlagSeverity;
  title: string;
  explanation: string;
};

export type PreparerNotesSection = {
  flags: PreparerFlag[];
  generated_at: string;
};

export type VerificationAuditSection = {
  entries: VerificationAuditEntry[];
  total_corrections: number;
  total_verified_unchanged: number;
  signator_attestation: string | null;
  signator_approved_at: string | null;
  model_locked_at: string | null;
  model_locked_by: string | null;
};

export type ReportSection =
  | { kind: 'identification'; data: IdentificationSection }
  | { kind: 'payment_schedule'; data: PaymentScheduleSection }
  | { kind: 'asc842_inputs'; data: Asc842InputsSection }
  | { kind: 'key_terms'; data: KeyTermsSection }
  | { kind: 'preparer_notes'; data: PreparerNotesSection }
  | { kind: 'verification_audit'; data: VerificationAuditSection };

// ─── Portfolio types ────────────────────────────────────────────────────

export type WorkspacePortfolioContext = {
  workspace_id: string;
  organization_name: string;
  fiscal_year_start_month: number;
  rounding_precision: number;
  discount_rate_method: string;
};

export type ExclusionReason =
  | 'not_model_locked'
  | 'not_active'
  | 'period_no_overlap'
  | 'verification_incomplete'
  | 'other';

export type ExcludedLease = {
  lease_id: string;
  reason: ExclusionReason;
  detail: string | null;
};

export type ExclusionGroup = {
  reason: ExclusionReason;
  lease_ids: string[];
  count: number;
};

export type PerLeaseSummary = {
  lease_id: string;
  tenant_name: string | null;
  property_address: string | null;
  classification: LeaseClassification;
  pv_liability: number | null;
  total_commitment: number | null;
  straight_line_monthly_expense: number | null;
  commencement_date: string | null;
  expiration_date: string | null;
  flag_count: number;
  high_severity_flag_count: number;
};

export type PortfolioTotals = {
  lease_count: number;
  excluded_count: number;
  total_pv_liability: number;
  total_commitment: number;
  total_monthly_straight_line: number;
  operating_lease_count: number;
  finance_lease_count: number;
  pending_classification_count: number;
};

export type PortfolioReport = {
  schema_version: string;
  report_metadata: {
    workspace_id: string;
    organization_name: string;
    period_start: string;
    period_end: string;
    generated_at: string;
    report_type: 'portfolio_period';
    not_a_financial_statement: true;
    liability_disclaimer: string;
    fiscal_year_start_month: number;
    rounding_precision: number;
    discount_rate_method: string;
  };
  totals: PortfolioTotals;
  per_lease_summaries: PerLeaseSummary[];
  exclusions: ExclusionGroup[];
  preparer_notes: PreparerNotesSection;
};

// ─── Helpers ────────────────────────────────────────────────────────────

function lookupCitation(
  citations: Record<string, Citation>,
  fieldId: string,
): Citation | null {
  const c = citations[fieldId];
  return c ? { snippet: c.snippet, page: c.page } : null;
}

function hasRentEscalations(schedule: RentPeriod[]): boolean {
  for (let i = 1; i < schedule.length; i++) {
    if (schedule[i].monthly_amount !== schedule[i - 1].monthly_amount) {
      return true;
    }
  }
  return false;
}

function sumPaymentSchedule(schedule: RentPeriod[]): number {
  let total = 0;
  for (const period of schedule) {
    total += Number.isFinite(period.annual_amount)
      ? period.annual_amount
      : 0;
  }
  return total;
}

function periodOverlaps(
  leaseStart: string | null,
  leaseEnd: string | null,
  periodStart: string,
  periodEnd: string,
): boolean {
  if (!leaseStart || !leaseEnd) return false;
  // Overlap: leaseStart <= periodEnd AND leaseEnd >= periodStart
  return leaseStart <= periodEnd && leaseEnd >= periodStart;
}

// ─── Section builders ───────────────────────────────────────────────────

export function buildIdentificationSection(
  inputs: ReportInputs,
): IdentificationSection {
  const entries: Array<[string, string, string | null]> = [
    ['tenant_name', 'Tenant', inputs.tenant_name],
    ['landlord_name', 'Landlord', inputs.landlord_name],
    ['property_address', 'Property Address', inputs.property_address],
    ['asset_type', 'Asset Type', inputs.asset_type],
    ['execution_date', 'Execution Date', inputs.execution_date],
    ['commencement_date', 'Commencement Date', inputs.commencement_date],
    [
      'rent_commencement_date',
      'Rent Commencement Date',
      inputs.rent_commencement_date,
    ],
    ['expiration_date', 'Expiration Date', inputs.expiration_date],
    [
      'term_months',
      'Term (months)',
      inputs.term_months !== null ? String(inputs.term_months) : null,
    ],
  ];
  return {
    fields: entries.map(([field_id, label, value]) => ({
      field_id,
      label,
      value,
      citation: lookupCitation(inputs.field_citations, field_id),
    })),
  };
}

export function buildPaymentScheduleSection(
  inputs: ReportInputs,
): PaymentScheduleSection {
  const total =
    inputs.total_commitment !== null
      ? inputs.total_commitment
      : inputs.rent_schedule.length > 0
        ? sumPaymentSchedule(inputs.rent_schedule)
        : null;
  return {
    periods: inputs.rent_schedule,
    total_periods: inputs.rent_schedule.length,
    total_cash_commitment: total,
    has_escalations: hasRentEscalations(inputs.rent_schedule),
    citation: lookupCitation(inputs.field_citations, 'rent_schedule'),
  };
}

export function buildAsc842InputsSection(
  inputs: ReportInputs,
): Asc842InputsSection {
  return {
    classification: inputs.lease_classification,
    classification_set_at: inputs.classification_set_at,
    classification_set_by: inputs.classification_set_by_user_label,
    discount_rate_percent: inputs.discount_rate,
    pv_liability: inputs.pv_liability,
    total_commitment: inputs.total_commitment,
    straight_line_monthly_expense: inputs.straight_line_monthly_expense,
    cash_pl_delta: inputs.cash_pl_delta,
    term_months: inputs.term_months,
    commencement_date: inputs.commencement_date,
    expiration_date: inputs.expiration_date,
    per_lease_inputs: inputs.asc842_inputs,
  };
}

export function buildKeyTermsSection(inputs: ReportInputs): KeyTermsSection {
  return {
    security_deposit: inputs.security_deposit,
    security_deposit_citation: lookupCitation(
      inputs.field_citations,
      'security_deposit',
    ),
    rent_commencement_date: inputs.rent_commencement_date,
    execution_date: inputs.execution_date,
    asset_type: inputs.asset_type,
    escalation_clause: inputs.escalation_clause,
    escalation_citation: lookupCitation(
      inputs.field_citations,
      'escalation_clause',
    ),
    renewal_options: inputs.renewal_options,
    renewal_citation: lookupCitation(
      inputs.field_citations,
      'renewal_options',
    ),
    termination_clause: inputs.termination_clause,
    termination_citation: lookupCitation(
      inputs.field_citations,
      'termination_clause',
    ),
  };
}

// The preparer notes section is the most important automated content in
// the report. It surfaces flags the accountant or downstream AI tool
// needs to know about before generating journal entries. Each flag is
// specific, actionable, and grounded in real ASC 842 considerations.
export function buildPreparerNotesSection(
  inputs: ReportInputs,
): PreparerNotesSection {
  const flags: PreparerFlag[] = [];

  if (inputs.lease_classification === 'pending') {
    flags.push({
      severity: 'high',
      title: 'Lease classification not finalized',
      explanation:
        'The lease has not been classified as Operating or Finance. ASC 842 treatment differs materially between the two (operating: single straight-line lease expense; finance: separate interest + amortization). Classify before generating journal entries.',
    });
  }

  if (
    !Number.isFinite(inputs.discount_rate) ||
    inputs.discount_rate <= 0 ||
    inputs.discount_rate > 50
  ) {
    flags.push({
      severity: 'high',
      title: 'Discount rate out of plausible range',
      explanation: `Discount rate of ${inputs.discount_rate}% is outside the typical IBR range (typically 2-15%). Verify the rate is correct before relying on the present-value calculation.`,
    });
  }

  if (inputs.rent_schedule.length === 0) {
    flags.push({
      severity: 'high',
      title: 'No rent schedule recorded',
      explanation:
        'The lease has no rent periods recorded. Journal entries cannot be generated without a payment schedule. Add the schedule manually before producing accounting outputs.',
    });
  }

  if (
    hasRentEscalations(inputs.rent_schedule) &&
    (inputs.straight_line_monthly_expense ?? 0) === 0
  ) {
    flags.push({
      severity: 'medium',
      title: 'Rent escalations present but straight-line expense is zero',
      explanation:
        'The lease has escalating rent but no computed straight-line expense. ASC 842 requires straight-lining the total cash commitment over the lease term for operating leases. Verify the calculation in the underlying lease record.',
    });
  }

  if (inputs.model_locked_at === null) {
    flags.push({
      severity: 'high',
      title: 'Lease not yet finalized',
      explanation:
        'This lease has not been model-locked. The data has not passed final verification. Reports against unfinalized leases are draft only and should not be used for financial reporting.',
    });
  }

  if (
    inputs.commencement_date &&
    inputs.expiration_date &&
    inputs.commencement_date > inputs.expiration_date
  ) {
    flags.push({
      severity: 'high',
      title: 'Commencement date is after expiration date',
      explanation:
        'The recorded commencement date is later than the expiration date. This is almost certainly a data entry error and will produce nonsense in any term-based calculation.',
    });
  }

  if (
    inputs.term_months !== null &&
    inputs.term_months <= 12 &&
    inputs.lease_classification !== 'pending'
  ) {
    flags.push({
      severity: 'medium',
      title: 'Short-term lease — ASC 842 election may apply',
      explanation:
        'The lease term is 12 months or less. ASC 842 allows lessees to elect not to apply recognition requirements to short-term leases. If this election is intended, do not record a right-of-use asset or lease liability; instead, recognize the payments as expense over the term. Confirm the policy with the customer.',
    });
  }

  // ─── ASC 842 inputs rules ────────────────────────────────────────
  // The "always-on TI/IDC" flag from schema 1.0.0 becomes CONDITIONAL:
  // only fires if those fields are NULL (unconfirmed). Once captured
  // (even as zero), the flag clears.
  const a = inputs.asc842_inputs;
  if (a === null) {
    flags.push({
      severity: 'high',
      title: 'ASC 842 inputs not captured',
      explanation:
        'No per-lease ASC 842 inputs have been recorded for this lease (TI allowance, initial direct costs, residual guarantees, classification criteria, term assessment). These are NOT extracted by the AI pipeline and must be captured manually before the disclosure report is reliable. Open the lease detail page → ASC 842 Inputs tab.',
    });
  } else {
    if (a.tenant_improvement_allowance === null) {
      flags.push({
        severity: 'medium',
        title: 'Tenant improvement allowance not confirmed',
        explanation:
          'TI allowance reduces the right-of-use asset under ASC 842-20-25-1. Capture the amount (zero is a valid answer) so the report can either reflect it or document its absence.',
      });
    }
    if (a.initial_direct_costs === null) {
      flags.push({
        severity: 'medium',
        title: 'Initial direct costs not confirmed',
        explanation:
          'Initial direct costs increase the right-of-use asset under ASC 842-20-30-5. Capture the amount (zero is a valid answer) so the report can either reflect it or document its absence.',
      });
    }
    if (a.lease_incentives_received === null) {
      flags.push({
        severity: 'low',
        title: 'Lease incentives received not confirmed',
        explanation:
          'Confirm whether the lessor provided any incentives (free-rent periods, moving allowances). Reduces the ROU asset.',
      });
    }
    if (a.prepaid_rent === null) {
      flags.push({
        severity: 'low',
        title: 'Prepaid rent not confirmed',
        explanation:
          'Confirm whether any rent was prepaid at or before commencement. Added to the ROU asset.',
      });
    }
    // Classification criteria: if none of the 5 finance-lease tests is
    // affirmed AND the lease is not classified, flag for review.
    if (
      inputs.lease_classification === 'pending' &&
      a.ownership_transfers_at_end !== true &&
      a.bargain_purchase_option !== true &&
      a.major_part_economic_life !== true &&
      a.pv_substantially_all_fair_value !== true &&
      a.specialized_asset_no_alt_use !== true
    ) {
      flags.push({
        severity: 'high',
        title: 'Classification criteria not assessed',
        explanation:
          'None of the 5 ASC 842-10-25-2 finance-lease tests have been affirmed AND the lease is not yet classified. Capture each test (true/false with basis) so the operating-vs-finance determination is auditable.',
      });
    }
    // Purchase option recorded but RC flag not set
    if (
      a.purchase_option_present === true &&
      a.purchase_option_reasonably_certain === null
    ) {
      flags.push({
        severity: 'high',
        title: 'Purchase option present but reasonably-certain flag missing',
        explanation:
          'A purchase option is recorded but the lessee has not assessed whether exercise is reasonably certain. This determination materially affects the lease liability (the option price is included if RC). Set the flag and document the basis.',
      });
    }
    // Finance lease without residual value guarantee assessed
    if (
      inputs.lease_classification === 'finance' &&
      a.residual_value_guarantee === null
    ) {
      flags.push({
        severity: 'high',
        title: 'Finance lease without residual value guarantee assessment',
        explanation:
          'Finance leases must consider any residual value guarantee in the lease liability. Capture the amount (zero is a valid answer if no guarantee exists).',
      });
    }
    // Renewal options RC term but no basis
    if (
      a.renewal_options_rc_term_months !== null &&
      a.renewal_options_rc_term_months > 0 &&
      (a.renewal_options_rc_basis === null ||
        a.renewal_options_rc_basis.trim().length < 10)
    ) {
      flags.push({
        severity: 'medium',
        title: 'Renewal-options term-extension lacks basis',
        explanation:
          'You have extended the lease term to include reasonably-certain renewal options. ASC 842 requires this judgment to be documented. Provide a basis description of at least 10 characters.',
      });
    }
    // Variable payments described but no estimate
    if (
      a.variable_payments_description !== null &&
      a.variable_payments_description.trim().length > 0 &&
      a.variable_payments_estimated_annual === null
    ) {
      flags.push({
        severity: 'low',
        title: 'Variable payments described but no annual estimate',
        explanation:
          'Variable payments are excluded from the lease liability but disclosed under ASC 842-20-50. Provide an estimated annual amount for the disclosure.',
      });
    }
  }

  return { flags, generated_at: new Date().toISOString() };
}

export function buildVerificationAuditSection(
  inputs: ReportInputs,
): VerificationAuditSection {
  let corrections = 0;
  let verifiedUnchanged = 0;
  for (const entry of inputs.verification_audit) {
    if (entry.correction_type === 'verified_unchanged') {
      verifiedUnchanged += 1;
    } else {
      corrections += 1;
    }
  }
  return {
    entries: inputs.verification_audit,
    total_corrections: corrections,
    total_verified_unchanged: verifiedUnchanged,
    signator_attestation: inputs.signator_attestation,
    signator_approved_at: inputs.signator_approved_at,
    model_locked_at: inputs.model_locked_at,
    model_locked_by: inputs.model_locked_by_user_label,
  };
}

// Builds the full set of sections for a single-lease disclosure report.
// Pure function — given inputs, returns sections deterministically.
export function buildLeaseDisclosureSections(
  inputs: ReportInputs,
): ReportSection[] {
  return [
    { kind: 'identification', data: buildIdentificationSection(inputs) },
    { kind: 'payment_schedule', data: buildPaymentScheduleSection(inputs) },
    { kind: 'asc842_inputs', data: buildAsc842InputsSection(inputs) },
    { kind: 'key_terms', data: buildKeyTermsSection(inputs) },
    { kind: 'preparer_notes', data: buildPreparerNotesSection(inputs) },
    {
      kind: 'verification_audit',
      data: buildVerificationAuditSection(inputs),
    },
  ];
}

// ─── JSON output ────────────────────────────────────────────────────────

// Builds the JSON output for a single-lease disclosure report. The JSON
// is the structured data file the customer hands to their CPA, AI tool,
// or ERP. It must be self-contained, complete, and schema-stable across
// versions. Backward-incompatible changes require a major bump of
// REPORT_SCHEMA_VERSION and an update to docs/JSON_REPORT_SCHEMA.md.
export function buildLeaseDisclosureJson(
  inputs: ReportInputs,
): Record<string, unknown> {
  const identification = buildIdentificationSection(inputs);
  const payment = buildPaymentScheduleSection(inputs);
  const asc842 = buildAsc842InputsSection(inputs);
  const keyTerms = buildKeyTermsSection(inputs);
  const verification = buildVerificationAuditSection(inputs);
  const preparer = buildPreparerNotesSection(inputs);

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    report_metadata: {
      lease_id: inputs.lease_id,
      workspace_id: inputs.workspace_id,
      generated_at: new Date().toISOString(),
      report_type: 'lease_disclosure',
      not_a_financial_statement: true,
      liability_disclaimer: LIABILITY_DISCLAIMER,
      banner: NOT_A_FINANCIAL_STATEMENT_BANNER,
    },
    lease_identification: {
      fields: identification.fields,
    },
    payment_schedule: {
      periods: payment.periods,
      total_periods: payment.total_periods,
      total_cash_commitment: payment.total_cash_commitment,
      has_escalations: payment.has_escalations,
      citation: payment.citation,
    },
    asc842_inputs: asc842,
    asc842_per_lease_inputs: inputs.asc842_inputs,
    key_terms: keyTerms,
    preparer_notes: preparer,
    verification_audit: {
      entries: verification.entries,
      total_corrections: verification.total_corrections,
      total_verified_unchanged: verification.total_verified_unchanged,
      signator_attestation: {
        attestation_text: verification.signator_attestation,
        signed_at: verification.signator_approved_at,
      },
      model_locked: {
        locked_at: verification.model_locked_at,
        locked_by: verification.model_locked_by,
      },
    },
    field_citations: inputs.field_citations,
  };
}

// ─── Portfolio-period builder ───────────────────────────────────────────

function summarizeLease(inputs: ReportInputs): PerLeaseSummary {
  const preparer = buildPreparerNotesSection(inputs);
  const highSeverity = preparer.flags.filter((f) => f.severity === 'high')
    .length;
  return {
    lease_id: inputs.lease_id,
    tenant_name: inputs.tenant_name,
    property_address: inputs.property_address,
    classification: inputs.lease_classification,
    pv_liability: inputs.pv_liability,
    total_commitment: inputs.total_commitment,
    straight_line_monthly_expense: inputs.straight_line_monthly_expense,
    commencement_date: inputs.commencement_date,
    expiration_date: inputs.expiration_date,
    flag_count: preparer.flags.length,
    high_severity_flag_count: highSeverity,
  };
}

function groupExclusions(excluded: ExcludedLease[]): ExclusionGroup[] {
  const buckets = new Map<ExclusionReason, string[]>();
  for (const e of excluded) {
    const list = buckets.get(e.reason) ?? [];
    list.push(e.lease_id);
    buckets.set(e.reason, list);
  }
  const ordered: ExclusionReason[] = [
    'not_model_locked',
    'not_active',
    'period_no_overlap',
    'verification_incomplete',
    'other',
  ];
  const out: ExclusionGroup[] = [];
  for (const reason of ordered) {
    const ids = buckets.get(reason);
    if (ids && ids.length > 0) {
      out.push({ reason, lease_ids: ids, count: ids.length });
    }
  }
  return out;
}

function buildPortfolioPreparerNotes(
  leases: ReportInputs[],
  excluded: ExcludedLease[],
  period: { start: string; end: string },
): PreparerNotesSection {
  const flags: PreparerFlag[] = [];

  if (leases.length === 0) {
    flags.push({
      severity: 'high',
      title: 'No eligible leases in period',
      explanation:
        'No model-locked, active leases were found that overlap the requested period. Confirm leases are model-locked and that the period bounds are correct.',
    });
  }

  const pendingClassification = leases.filter(
    (l) => l.lease_classification === 'pending',
  ).length;
  if (pendingClassification > 0) {
    flags.push({
      severity: 'high',
      title: `${pendingClassification} lease(s) with unfinalized classification`,
      explanation:
        'One or more leases in this report have not been classified as Operating or Finance. ASC 842 treatment differs materially. The portfolio totals include these leases but their treatment is ambiguous until classified.',
    });
  }

  const missingDiscountRate = leases.filter(
    (l) =>
      !Number.isFinite(l.discount_rate) ||
      l.discount_rate <= 0 ||
      l.discount_rate > 50,
  ).length;
  if (missingDiscountRate > 0) {
    flags.push({
      severity: 'high',
      title: `${missingDiscountRate} lease(s) with implausible discount rate`,
      explanation:
        'One or more leases have a discount rate of zero, negative, or above 50%. Their PV liability is unreliable. Verify the workspace IBR or per-lease overrides.',
    });
  }

  const noSchedule = leases.filter((l) => l.rent_schedule.length === 0).length;
  if (noSchedule > 0) {
    flags.push({
      severity: 'medium',
      title: `${noSchedule} lease(s) without rent schedule`,
      explanation:
        'One or more leases have no rent schedule. Their commitment and PV totals contribute zero to the portfolio totals. Add the schedules before relying on the aggregate.',
    });
  }

  if (excluded.length > 0) {
    flags.push({
      severity: 'medium',
      title: `${excluded.length} lease(s) excluded from totals`,
      explanation:
        'See the exclusions section for the per-lease reasons. Excluded leases do NOT contribute to the totals; resolve the exclusion conditions and regenerate the report if you need them included.',
    });
  }

  flags.push({
    severity: 'medium',
    title:
      'Tenant improvement allowances and initial direct costs require manual confirmation',
    explanation:
      'LeaseIO does not extract tenant improvement allowances or initial direct costs. Both affect the right-of-use asset measurement under ASC 842. Confirm at the per-lease level before finalizing portfolio-level disclosures.',
  });

  // Tag the period in a low-severity informational flag so the PDF
  // header has a stable place to surface "what period does this
  // cover?" even if upstream metadata is later trimmed.
  flags.push({
    severity: 'low',
    title: 'Period covered',
    explanation: `This portfolio-period report covers ${period.start} through ${period.end}. Only leases with a term overlapping this window are included.`,
  });

  return { flags, generated_at: new Date().toISOString() };
}

// Builds a portfolio-period report from many lease inputs. Aggregates
// totals, surfaces per-lease summaries, and includes preparer notes at
// the portfolio level for cross-cutting concerns. The caller is
// responsible for filtering to model_locked + active + period-overlap
// leases; this function aggregates whatever it's given. The
// `excluded` list is for leases the caller decided to drop and wants
// the reader to see by reason.
export function buildPortfolioPeriodReport(
  leases: ReportInputs[],
  excluded: ExcludedLease[],
  period: { start: string; end: string },
  workspaceContext: WorkspacePortfolioContext,
): PortfolioReport {
  let pv = 0;
  let commitment = 0;
  let monthlySl = 0;
  let operating = 0;
  let finance = 0;
  let pending = 0;
  for (const l of leases) {
    pv += l.pv_liability ?? 0;
    commitment += l.total_commitment ?? 0;
    monthlySl += l.straight_line_monthly_expense ?? 0;
    if (l.lease_classification === 'operating') operating += 1;
    else if (l.lease_classification === 'finance') finance += 1;
    else pending += 1;
  }

  const totals: PortfolioTotals = {
    lease_count: leases.length,
    excluded_count: excluded.length,
    total_pv_liability: pv,
    total_commitment: commitment,
    total_monthly_straight_line: monthlySl,
    operating_lease_count: operating,
    finance_lease_count: finance,
    pending_classification_count: pending,
  };

  const perLeaseSummaries = leases.map(summarizeLease);
  const exclusions = groupExclusions(excluded);
  const preparer = buildPortfolioPreparerNotes(leases, excluded, period);

  return {
    schema_version: REPORT_SCHEMA_VERSION,
    report_metadata: {
      workspace_id: workspaceContext.workspace_id,
      organization_name: workspaceContext.organization_name,
      period_start: period.start,
      period_end: period.end,
      generated_at: new Date().toISOString(),
      report_type: 'portfolio_period',
      not_a_financial_statement: true,
      liability_disclaimer: LIABILITY_DISCLAIMER,
      fiscal_year_start_month: workspaceContext.fiscal_year_start_month,
      rounding_precision: workspaceContext.rounding_precision,
      discount_rate_method: workspaceContext.discount_rate_method,
    },
    totals,
    per_lease_summaries: perLeaseSummaries,
    exclusions,
    preparer_notes: preparer,
  };
}

// Determines which leases from a candidate list belong in a portfolio
// report for a given period and which are excluded. The caller has
// already filtered by workspace; this function applies the report-
// eligibility criteria from PHASE_8_BUILD_SPEC.md
// (model_locked + active + period overlap). Exposed as a pure helper so
// the edge function can call it and unit tests can verify its decisions
// without spinning up a database.
export type PortfolioCandidate = {
  lease_id: string;
  model_locked: boolean;
  lifecycle_status: string | null;
  commencement_date: string | null;
  expiration_date: string | null;
  verification_complete: boolean;
};

export type PortfolioPartition = {
  included_lease_ids: string[];
  excluded: ExcludedLease[];
};

export function partitionPortfolioCandidates(
  candidates: PortfolioCandidate[],
  period: { start: string; end: string },
): PortfolioPartition {
  const included: string[] = [];
  const excluded: ExcludedLease[] = [];
  for (const c of candidates) {
    if (!c.model_locked) {
      excluded.push({
        lease_id: c.lease_id,
        reason: 'not_model_locked',
        detail: null,
      });
      continue;
    }
    if (c.lifecycle_status !== 'active') {
      excluded.push({
        lease_id: c.lease_id,
        reason: 'not_active',
        detail: c.lifecycle_status ?? null,
      });
      continue;
    }
    if (
      !periodOverlaps(
        c.commencement_date,
        c.expiration_date,
        period.start,
        period.end,
      )
    ) {
      excluded.push({
        lease_id: c.lease_id,
        reason: 'period_no_overlap',
        detail: null,
      });
      continue;
    }
    if (!c.verification_complete) {
      excluded.push({
        lease_id: c.lease_id,
        reason: 'verification_incomplete',
        detail: null,
      });
      continue;
    }
    included.push(c.lease_id);
  }
  return { included_lease_ids: included, excluded };
}
