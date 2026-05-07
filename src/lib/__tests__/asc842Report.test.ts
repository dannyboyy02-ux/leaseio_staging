import { describe, it, expect } from 'vitest';
import {
  LIABILITY_DISCLAIMER,
  NOT_A_FINANCIAL_STATEMENT_BANNER,
  REPORT_SCHEMA_VERSION,
  buildAsc842InputsSection,
  buildIdentificationSection,
  buildKeyTermsSection,
  buildLeaseDisclosureJson,
  buildLeaseDisclosureSections,
  buildPaymentScheduleSection,
  buildPortfolioPeriodReport,
  buildPreparerNotesSection,
  buildVerificationAuditSection,
  partitionPortfolioCandidates,
  type EscalationClause,
  type ExcludedLease,
  type PortfolioCandidate,
  type RentPeriod,
  type ReportInputs,
  type RenewalOption,
  type TerminationClause,
  type VerificationAuditEntry,
  type WorkspacePortfolioContext,
} from '../asc842Report';

// ─── Fixtures ───────────────────────────────────────────────────────────

const baseRentSchedule: RentPeriod[] = [
  {
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    monthly_amount: 10_000,
    annual_amount: 120_000,
    notes: null,
  },
  {
    period_start: '2027-01-01',
    period_end: '2027-12-31',
    monthly_amount: 10_300,
    annual_amount: 123_600,
    notes: null,
  },
];

const baseAuditEntry: VerificationAuditEntry = {
  field_id: 'tenant_name',
  original_value: 'Acme Inc',
  corrected_value: 'Acme Inc',
  correction_type: 'verified_unchanged',
  corrected_at: '2026-04-01T10:00:00Z',
  corrected_by_user_label: 'jane.cpa@acme.test',
  ai_confidence_at_correction: 0.97,
};

function makeInputs(overrides: Partial<ReportInputs> = {}): ReportInputs {
  return {
    lease_id: 'lease-1',
    workspace_id: 'ws-1',
    tenant_name: 'Acme Inc',
    landlord_name: 'BigCo Properties',
    property_address: '123 Main St, Anywhere, USA',
    asset_type: 'property',
    execution_date: '2025-12-15',
    commencement_date: '2026-01-01',
    rent_commencement_date: '2026-01-01',
    expiration_date: '2027-12-31',
    term_months: 24,
    lease_classification: 'operating',
    classification_set_at: '2026-04-02T09:00:00Z',
    classification_set_by_user_label: 'jane.cpa@acme.test',
    discount_rate: 5.5,
    monthly_payment: 10_000,
    rent_schedule: baseRentSchedule,
    security_deposit: 20_000,
    pv_liability: 230_000,
    total_commitment: 243_600,
    straight_line_monthly_expense: 10_150,
    cash_pl_delta: 0,
    escalation_clause: { type: 'fixed_percent', rate: 3, notes: null },
    renewal_options: [],
    termination_clause: null,
    verification_audit: [baseAuditEntry],
    signator_attestation:
      'Reviewed all material terms; no further negotiation required.',
    signator_approved_at: '2026-04-15T15:00:00Z',
    model_locked_at: '2026-04-20T11:00:00Z',
    model_locked_by_user_label: 'admin@acme.test',
    field_citations: {
      tenant_name: { snippet: 'between Acme Inc, a Delaware corp', page: 1 },
      rent_schedule: { snippet: 'Base Rent of $10,000 per month', page: 4 },
      security_deposit: {
        snippet: 'Security Deposit of $20,000',
        page: 5,
      },
    },
    // Default fixture includes a full asc842_inputs row so the
    // preparer-notes "ASC 842 inputs not captured" rule does not
    // trigger by default. Tests that want to exercise the unconfirmed
    // path pass `asc842_inputs: null` (or set individual fields to
    // null) in overrides.
    asc842_inputs: {
      tenant_improvement_allowance: 0,
      tenant_improvement_allowance_basis: 'No TI allowance per lease section 3.4',
      initial_direct_costs: 0,
      initial_direct_costs_basis: 'No IDC incurred',
      prepaid_rent: 0,
      prepaid_rent_basis: 'No prepaid rent',
      lease_incentives_received: 0,
      lease_incentives_received_basis: 'No incentives',
      residual_value_guarantee: 0,
      residual_value_guarantee_basis: 'No RVG',
      purchase_option_present: false,
      purchase_option_price: null,
      purchase_option_reasonably_certain: null,
      purchase_option_basis: null,
      termination_penalty_amount: null,
      termination_penalty_reasonably_certain: null,
      termination_penalty_basis: null,
      ownership_transfers_at_end: false,
      bargain_purchase_option: false,
      major_part_economic_life: false,
      major_part_economic_life_pct: 60,
      pv_substantially_all_fair_value: false,
      pv_to_fair_value_pct: 80,
      asset_fair_value: 300_000,
      specialized_asset_no_alt_use: false,
      classification_criteria_basis: 'All five tests assessed; none met',
      renewal_options_rc_term_months: 0,
      renewal_options_rc_basis: null,
      short_term_lease_election: false,
      short_term_lease_election_basis: null,
      variable_payments_description: null,
      variable_payments_estimated_annual: null,
      sublease_income_annual: null,
      sublease_basis: null,
      last_updated_at: '2026-04-25T10:00:00Z',
      last_updated_by_label: 'jane.cpa@acme.test',
    },
    ...overrides,
  };
}

// ─── buildLeaseDisclosureSections ───────────────────────────────────────

describe('buildLeaseDisclosureSections', () => {
  it('returns six sections in the contracted order', () => {
    const sections = buildLeaseDisclosureSections(makeInputs());
    expect(sections.map((s) => s.kind)).toEqual([
      'identification',
      'payment_schedule',
      'asc842_inputs',
      'key_terms',
      'preparer_notes',
      'verification_audit',
    ]);
  });
});

// ─── buildIdentificationSection ─────────────────────────────────────────

describe('buildIdentificationSection', () => {
  it('emits the canonical identity field set in order', () => {
    const section = buildIdentificationSection(makeInputs());
    expect(section.fields.map((f) => f.field_id)).toEqual([
      'tenant_name',
      'landlord_name',
      'property_address',
      'asset_type',
      'execution_date',
      'commencement_date',
      'rent_commencement_date',
      'expiration_date',
      'term_months',
    ]);
  });

  it('attaches a citation when one exists for the field, null otherwise', () => {
    const section = buildIdentificationSection(makeInputs());
    const tenant = section.fields.find((f) => f.field_id === 'tenant_name');
    const landlord = section.fields.find((f) => f.field_id === 'landlord_name');
    expect(tenant?.citation).toEqual({
      snippet: 'between Acme Inc, a Delaware corp',
      page: 1,
    });
    expect(landlord?.citation).toBeNull();
  });

  it('preserves null values without coercion', () => {
    const section = buildIdentificationSection(
      makeInputs({ tenant_name: null, term_months: null }),
    );
    expect(
      section.fields.find((f) => f.field_id === 'tenant_name')?.value,
    ).toBeNull();
    expect(
      section.fields.find((f) => f.field_id === 'term_months')?.value,
    ).toBeNull();
  });

  it('stringifies term_months when present', () => {
    const section = buildIdentificationSection(
      makeInputs({ term_months: 36 }),
    );
    expect(
      section.fields.find((f) => f.field_id === 'term_months')?.value,
    ).toBe('36');
  });
});

// ─── buildPaymentScheduleSection ────────────────────────────────────────

describe('buildPaymentScheduleSection', () => {
  it('returns the schedule, period count, and has_escalations flag', () => {
    const section = buildPaymentScheduleSection(makeInputs());
    expect(section.total_periods).toBe(2);
    expect(section.has_escalations).toBe(true);
    expect(section.total_cash_commitment).toBe(243_600);
  });

  it('detects no escalations when monthly amounts are flat', () => {
    const section = buildPaymentScheduleSection(
      makeInputs({
        rent_schedule: [
          { ...baseRentSchedule[0] },
          { ...baseRentSchedule[1], monthly_amount: 10_000 },
        ],
      }),
    );
    expect(section.has_escalations).toBe(false);
  });

  it('falls back to summing annual_amount when total_commitment is null', () => {
    const section = buildPaymentScheduleSection(
      makeInputs({ total_commitment: null }),
    );
    expect(section.total_cash_commitment).toBe(243_600);
  });

  it('returns null total when no schedule and no commitment', () => {
    const section = buildPaymentScheduleSection(
      makeInputs({ total_commitment: null, rent_schedule: [] }),
    );
    expect(section.total_cash_commitment).toBeNull();
    expect(section.total_periods).toBe(0);
    expect(section.has_escalations).toBe(false);
  });
});

// ─── buildAsc842InputsSection ───────────────────────────────────────────

describe('buildAsc842InputsSection', () => {
  it('passes through precomputed values', () => {
    const section = buildAsc842InputsSection(makeInputs());
    expect(section.classification).toBe('operating');
    expect(section.discount_rate_percent).toBe(5.5);
    expect(section.pv_liability).toBe(230_000);
    expect(section.total_commitment).toBe(243_600);
    expect(section.straight_line_monthly_expense).toBe(10_150);
    expect(section.term_months).toBe(24);
  });

  it('preserves null computed values', () => {
    const section = buildAsc842InputsSection(
      makeInputs({
        pv_liability: null,
        straight_line_monthly_expense: null,
        cash_pl_delta: null,
      }),
    );
    expect(section.pv_liability).toBeNull();
    expect(section.straight_line_monthly_expense).toBeNull();
    expect(section.cash_pl_delta).toBeNull();
  });
});

// ─── buildKeyTermsSection ───────────────────────────────────────────────

describe('buildKeyTermsSection', () => {
  it('emits security_deposit and its citation', () => {
    const section = buildKeyTermsSection(makeInputs());
    expect(section.security_deposit).toBe(20_000);
    expect(section.security_deposit_citation).toEqual({
      snippet: 'Security Deposit of $20,000',
      page: 5,
    });
  });

  it('passes escalation/renewal/termination through unchanged', () => {
    const escalation: EscalationClause = {
      type: 'cpi',
      rate: null,
      notes: 'CPI capped at 5%',
    };
    const renewal: RenewalOption[] = [
      {
        option_term_months: 60,
        notice_required_days: 180,
        notes: 'Tenant exercise',
      },
    ];
    const termination: TerminationClause = {
      early_termination_allowed: true,
      notice_days: 90,
      penalty_amount: 50_000,
      notes: null,
    };
    const section = buildKeyTermsSection(
      makeInputs({
        escalation_clause: escalation,
        renewal_options: renewal,
        termination_clause: termination,
      }),
    );
    expect(section.escalation_clause).toEqual(escalation);
    expect(section.renewal_options).toEqual(renewal);
    expect(section.termination_clause).toEqual(termination);
  });

  it('returns null for missing key-term citations without throwing', () => {
    const section = buildKeyTermsSection(makeInputs());
    expect(section.escalation_citation).toBeNull();
    expect(section.renewal_citation).toBeNull();
    expect(section.termination_citation).toBeNull();
  });
});

// ─── buildPreparerNotesSection ──────────────────────────────────────────

describe('buildPreparerNotesSection', () => {
  // Schema 1.1.0 — the always-on TI/IDC flag became conditional.
  // It now fires ONLY when the per-lease asc842_inputs.tenant_improvement_allowance
  // or initial_direct_costs is NULL (unconfirmed). Once captured (even
  // as zero), the flag clears.
  it('flags TI allowance only when null (unconfirmed)', () => {
    const inputs = makeInputs();
    const sectionWith = buildPreparerNotesSection(inputs);
    expect(
      sectionWith.flags.some((f) =>
        f.title === 'Tenant improvement allowance not confirmed',
      ),
    ).toBe(false);
    const sectionWithout = buildPreparerNotesSection(
      makeInputs({
        asc842_inputs: {
          ...inputs.asc842_inputs!,
          tenant_improvement_allowance: null,
          tenant_improvement_allowance_basis: null,
        },
      }),
    );
    expect(
      sectionWithout.flags.some(
        (f) => f.title === 'Tenant improvement allowance not confirmed',
      ),
    ).toBe(true);
  });

  it('flags initial direct costs only when null (unconfirmed)', () => {
    const inputs = makeInputs();
    const section = buildPreparerNotesSection(
      makeInputs({
        asc842_inputs: {
          ...inputs.asc842_inputs!,
          initial_direct_costs: null,
          initial_direct_costs_basis: null,
        },
      }),
    );
    expect(
      section.flags.some((f) => f.title === 'Initial direct costs not confirmed'),
    ).toBe(true);
  });

  it('flags ASC 842 inputs not captured when no row exists', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ asc842_inputs: null }),
    );
    const flag = section.flags.find(
      (f) => f.title === 'ASC 842 inputs not captured',
    );
    expect(flag?.severity).toBe('high');
  });

  it('flags pending classification with high severity', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ lease_classification: 'pending' }),
    );
    const flag = section.flags.find(
      (f) => f.title === 'Lease classification not finalized',
    );
    expect(flag?.severity).toBe('high');
  });

  it('flags out-of-range discount rate (zero, negative, > 50)', () => {
    for (const rate of [0, -3, 75]) {
      const section = buildPreparerNotesSection(
        makeInputs({ discount_rate: rate }),
      );
      expect(
        section.flags.some(
          (f) => f.title === 'Discount rate out of plausible range',
        ),
      ).toBe(true);
    }
  });

  it('does not flag a typical IBR', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ discount_rate: 6.0 }),
    );
    expect(
      section.flags.some(
        (f) => f.title === 'Discount rate out of plausible range',
      ),
    ).toBe(false);
  });

  it('flags missing rent schedule', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ rent_schedule: [] }),
    );
    const flag = section.flags.find(
      (f) => f.title === 'No rent schedule recorded',
    );
    expect(flag?.severity).toBe('high');
  });

  it('flags rent escalations without straight-line expense', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ straight_line_monthly_expense: 0 }),
    );
    expect(
      section.flags.some(
        (f) =>
          f.title ===
          'Rent escalations present but straight-line expense is zero',
      ),
    ).toBe(true);
  });

  it('flags non-locked leases with high severity', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ model_locked_at: null }),
    );
    expect(
      section.flags.some((f) => f.title === 'Lease not yet finalized'),
    ).toBe(true);
  });

  it('flags inverted commencement/expiration dates', () => {
    const section = buildPreparerNotesSection(
      makeInputs({
        commencement_date: '2027-01-01',
        expiration_date: '2026-01-01',
      }),
    );
    expect(
      section.flags.some(
        (f) => f.title === 'Commencement date is after expiration date',
      ),
    ).toBe(true);
  });

  it('flags short-term leases (≤ 12 months) when classified', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ term_months: 11 }),
    );
    expect(
      section.flags.some((f) =>
        f.title.startsWith('Short-term lease'),
      ),
    ).toBe(true);
  });

  it('does not flag short-term when classification is pending', () => {
    const section = buildPreparerNotesSection(
      makeInputs({ term_months: 11, lease_classification: 'pending' }),
    );
    expect(
      section.flags.some((f) => f.title.startsWith('Short-term lease')),
    ).toBe(false);
  });

  it('emits a generated_at ISO timestamp', () => {
    const section = buildPreparerNotesSection(makeInputs());
    expect(() => new Date(section.generated_at).toISOString()).not.toThrow();
  });
});

// ─── buildVerificationAuditSection ──────────────────────────────────────

describe('buildVerificationAuditSection', () => {
  it('counts corrections vs verified-unchanged', () => {
    const inputs = makeInputs({
      verification_audit: [
        { ...baseAuditEntry, correction_type: 'verified_unchanged' },
        {
          ...baseAuditEntry,
          field_id: 'monthly_payment',
          correction_type: 'edit',
          original_value: '9000',
          corrected_value: '10000',
        },
        {
          ...baseAuditEntry,
          field_id: 'security_deposit',
          correction_type: 'add_missing',
          original_value: null,
          corrected_value: '20000',
        },
      ],
    });
    const section = buildVerificationAuditSection(inputs);
    expect(section.total_corrections).toBe(2);
    expect(section.total_verified_unchanged).toBe(1);
  });

  it('passes through signator attestation + lock metadata', () => {
    const section = buildVerificationAuditSection(makeInputs());
    expect(section.signator_attestation).toContain('Reviewed all material');
    expect(section.signator_approved_at).toBe('2026-04-15T15:00:00Z');
    expect(section.model_locked_at).toBe('2026-04-20T11:00:00Z');
    expect(section.model_locked_by).toBe('admin@acme.test');
  });
});

// ─── buildLeaseDisclosureJson ───────────────────────────────────────────

describe('buildLeaseDisclosureJson', () => {
  it('emits schema_version 1.0.0', () => {
    const json = buildLeaseDisclosureJson(makeInputs()) as Record<string, unknown>;
    expect(json.schema_version).toBe('1.0.0');
    expect(REPORT_SCHEMA_VERSION).toBe('1.0.0');
  });

  it('marks the report as not a financial statement and includes the disclaimer', () => {
    const json = buildLeaseDisclosureJson(makeInputs()) as Record<string, unknown>;
    const meta = json.report_metadata as Record<string, unknown>;
    expect(meta.not_a_financial_statement).toBe(true);
    expect(meta.liability_disclaimer).toBe(LIABILITY_DISCLAIMER);
    expect(meta.banner).toBe(NOT_A_FINANCIAL_STATEMENT_BANNER);
    expect(meta.report_type).toBe('lease_disclosure');
  });

  it('includes verification audit + citations + key terms + preparer notes', () => {
    const json = buildLeaseDisclosureJson(makeInputs()) as Record<string, unknown>;
    expect(json.verification_audit).toBeDefined();
    expect(json.field_citations).toEqual(makeInputs().field_citations);
    expect(json.key_terms).toBeDefined();
    expect(json.preparer_notes).toBeDefined();
    expect(json.lease_identification).toBeDefined();
    expect(json.payment_schedule).toBeDefined();
    expect(json.asc842_inputs).toBeDefined();
  });

  it('includes signator attestation block under verification_audit', () => {
    const json = buildLeaseDisclosureJson(makeInputs()) as Record<string, unknown>;
    const audit = json.verification_audit as Record<string, unknown>;
    const attest = audit.signator_attestation as Record<string, unknown>;
    expect(attest.attestation_text).toContain('Reviewed all material');
    expect(attest.signed_at).toBe('2026-04-15T15:00:00Z');
  });
});

// ─── partitionPortfolioCandidates ───────────────────────────────────────

describe('partitionPortfolioCandidates', () => {
  const period = { start: '2026-01-01', end: '2026-12-31' };

  const make = (
    overrides: Partial<PortfolioCandidate>,
  ): PortfolioCandidate => ({
    lease_id: overrides.lease_id ?? 'lease-x',
    model_locked: true,
    lifecycle_status: 'active',
    commencement_date: '2026-01-01',
    expiration_date: '2027-12-31',
    verification_complete: true,
    ...overrides,
  });

  it('includes a fully eligible lease', () => {
    const result = partitionPortfolioCandidates(
      [make({ lease_id: 'L1' })],
      period,
    );
    expect(result.included_lease_ids).toEqual(['L1']);
    expect(result.excluded).toEqual([]);
  });

  it('excludes by reason in priority order: lock → active → overlap → verified', () => {
    const result = partitionPortfolioCandidates(
      [
        make({ lease_id: 'L_unlocked', model_locked: false }),
        make({
          lease_id: 'L_inactive',
          lifecycle_status: 'in_negotiation',
        }),
        make({
          lease_id: 'L_no_overlap',
          commencement_date: '2030-01-01',
          expiration_date: '2031-12-31',
        }),
        make({ lease_id: 'L_unverified', verification_complete: false }),
      ],
      period,
    );
    expect(result.included_lease_ids).toEqual([]);
    expect(
      result.excluded.find((e) => e.lease_id === 'L_unlocked')?.reason,
    ).toBe('not_model_locked');
    expect(
      result.excluded.find((e) => e.lease_id === 'L_inactive')?.reason,
    ).toBe('not_active');
    expect(
      result.excluded.find((e) => e.lease_id === 'L_no_overlap')?.reason,
    ).toBe('period_no_overlap');
    expect(
      result.excluded.find((e) => e.lease_id === 'L_unverified')?.reason,
    ).toBe('verification_incomplete');
  });

  it('treats lease term that fully spans the period as overlapping', () => {
    const result = partitionPortfolioCandidates(
      [
        make({
          lease_id: 'L_span',
          commencement_date: '2025-01-01',
          expiration_date: '2030-12-31',
        }),
      ],
      period,
    );
    expect(result.included_lease_ids).toEqual(['L_span']);
  });

  it('treats partial overlap (lease ends mid-period) as overlapping', () => {
    const result = partitionPortfolioCandidates(
      [
        make({
          lease_id: 'L_partial',
          commencement_date: '2025-06-01',
          expiration_date: '2026-06-30',
        }),
      ],
      period,
    );
    expect(result.included_lease_ids).toEqual(['L_partial']);
  });
});

// ─── buildPortfolioPeriodReport ─────────────────────────────────────────

describe('buildPortfolioPeriodReport', () => {
  const period = { start: '2026-01-01', end: '2026-12-31' };
  const ctx: WorkspacePortfolioContext = {
    workspace_id: 'ws-1',
    organization_name: 'Acme Inc',
    fiscal_year_start_month: 1,
    rounding_precision: 2,
    discount_rate_method: 'incremental_borrowing_rate',
  };

  it('aggregates totals correctly across multiple leases', () => {
    const leases = [
      makeInputs({
        lease_id: 'L1',
        pv_liability: 100_000,
        total_commitment: 120_000,
        straight_line_monthly_expense: 10_000,
        lease_classification: 'operating',
      }),
      makeInputs({
        lease_id: 'L2',
        pv_liability: 50_000,
        total_commitment: 60_000,
        straight_line_monthly_expense: 5_000,
        lease_classification: 'finance',
      }),
      makeInputs({
        lease_id: 'L3',
        pv_liability: 25_000,
        total_commitment: 30_000,
        straight_line_monthly_expense: 2_500,
        lease_classification: 'pending',
      }),
    ];
    const report = buildPortfolioPeriodReport(leases, [], period, ctx);
    expect(report.totals.lease_count).toBe(3);
    expect(report.totals.excluded_count).toBe(0);
    expect(report.totals.total_pv_liability).toBe(175_000);
    expect(report.totals.total_commitment).toBe(210_000);
    expect(report.totals.total_monthly_straight_line).toBe(17_500);
    expect(report.totals.operating_lease_count).toBe(1);
    expect(report.totals.finance_lease_count).toBe(1);
    expect(report.totals.pending_classification_count).toBe(1);
  });

  it('treats null pv/commitment/sl as zero in aggregation', () => {
    const leases = [
      makeInputs({
        lease_id: 'L1',
        pv_liability: null,
        total_commitment: null,
        straight_line_monthly_expense: null,
      }),
    ];
    const report = buildPortfolioPeriodReport(leases, [], period, ctx);
    expect(report.totals.total_pv_liability).toBe(0);
    expect(report.totals.total_commitment).toBe(0);
    expect(report.totals.total_monthly_straight_line).toBe(0);
  });

  it('emits per-lease summaries with classification and flag counts', () => {
    const leases = [
      makeInputs({
        lease_id: 'L1',
        lease_classification: 'pending',
        rent_schedule: [],
      }),
    ];
    const report = buildPortfolioPeriodReport(leases, [], period, ctx);
    expect(report.per_lease_summaries).toHaveLength(1);
    expect(report.per_lease_summaries[0].lease_id).toBe('L1');
    expect(report.per_lease_summaries[0].classification).toBe('pending');
    // pending classification + no schedule both flagged → at least 2 high
    expect(
      report.per_lease_summaries[0].high_severity_flag_count,
    ).toBeGreaterThanOrEqual(2);
    expect(report.per_lease_summaries[0].flag_count).toBeGreaterThanOrEqual(2);
  });

  it('groups exclusions by reason in canonical order', () => {
    const excluded: ExcludedLease[] = [
      { lease_id: 'L_a', reason: 'not_active', detail: 'in_negotiation' },
      { lease_id: 'L_b', reason: 'not_model_locked', detail: null },
      { lease_id: 'L_c', reason: 'not_active', detail: 'rejected' },
      { lease_id: 'L_d', reason: 'verification_incomplete', detail: null },
    ];
    const report = buildPortfolioPeriodReport([], excluded, period, ctx);
    expect(report.exclusions.map((g) => g.reason)).toEqual([
      'not_model_locked',
      'not_active',
      'verification_incomplete',
    ]);
    const inactive = report.exclusions.find((g) => g.reason === 'not_active');
    expect(inactive?.lease_ids).toEqual(['L_a', 'L_c']);
    expect(inactive?.count).toBe(2);
  });

  it('produces a "no eligible leases" preparer flag on empty input', () => {
    const report = buildPortfolioPeriodReport([], [], period, ctx);
    expect(
      report.preparer_notes.flags.some(
        (f) => f.title === 'No eligible leases in period',
      ),
    ).toBe(true);
  });

  it('flags pending-classification count at portfolio level', () => {
    const leases = [
      makeInputs({ lease_id: 'L1', lease_classification: 'pending' }),
      makeInputs({ lease_id: 'L2', lease_classification: 'pending' }),
      makeInputs({ lease_id: 'L3', lease_classification: 'operating' }),
    ];
    const report = buildPortfolioPeriodReport(leases, [], period, ctx);
    expect(
      report.preparer_notes.flags.some((f) =>
        f.title.includes('2 lease(s) with unfinalized classification'),
      ),
    ).toBe(true);
  });

  it('emits report_metadata with workspace context + schema version', () => {
    const report = buildPortfolioPeriodReport(
      [makeInputs()],
      [],
      period,
      ctx,
    );
    expect(report.schema_version).toBe('1.0.0');
    expect(report.report_metadata.report_type).toBe('portfolio_period');
    expect(report.report_metadata.not_a_financial_statement).toBe(true);
    expect(report.report_metadata.organization_name).toBe('Acme Inc');
    expect(report.report_metadata.period_start).toBe(period.start);
    expect(report.report_metadata.period_end).toBe(period.end);
    expect(report.report_metadata.fiscal_year_start_month).toBe(1);
    expect(report.report_metadata.rounding_precision).toBe(2);
    expect(report.report_metadata.discount_rate_method).toBe(
      'incremental_borrowing_rate',
    );
  });
});
