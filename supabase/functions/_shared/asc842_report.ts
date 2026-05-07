// ─────────────────────────────────────────────────────────────────────────
// Pure ASC 842 disclosure-report helpers — Deno mirror.
//
// SYNC CONSTRAINT — DO NOT DRIFT
// This file MUST stay byte-equivalent in *behavior* with its Node
// counterpart:
//   src/lib/asc842Report.ts
//
// Both files contain identical pure functions and types. This Deno copy
// is imported by the Phase 8 edge functions (generate-lease-report,
// generate-portfolio-report). The Node copy is imported by the
// frontend (single-lease report detail page, portfolio-period report
// admin page) and by vitest unit tests in
// src/lib/__tests__/asc842Report.test.ts.
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

  // Tenant improvement allowances and initial direct costs are not
  // extracted by the AI pipeline. They affect ASC 842 measurement (TI
  // allowances reduce the ROU asset; initial direct costs are added to
  // it) and the customer must confirm them manually.
  flags.push({
    severity: 'medium',
    title:
      'Tenant improvement allowances and initial direct costs require manual confirmation',
    explanation:
      'LeaseIO does not extract tenant improvement allowances or initial direct costs from lease documents. Both affect the right-of-use asset measurement under ASC 842 (TI allowances reduce it; initial direct costs increase it). Confirm these amounts manually before finalizing journal entries.',
  });

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
