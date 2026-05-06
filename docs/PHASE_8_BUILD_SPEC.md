# Phase 8 Build Spec — ASC 842 Disclosure Report Generation

**Prerequisite reading:** All prior phase build specs (1 through 7), `APPROVAL_ROUTING_ARCHITECTURE.md`, `docs/PRODUCT_STRATEGY.md`, `docs/CLAUDE.md`, `docs/LEASEIO_TIER_OVERVIEW.md`
**Phase scope:** Generate the verified, audit-ready ASC 842 disclosure report that customers actually buy LeaseIO for. Per-lease individual reports and per-period multi-lease portfolio reports. Full citation trail back to source documents. Verification audit trail proving liability sits with the customer, not LeaseIO.
**Out of scope for Phase 8:** Firm-layer cross-workspace roll-up reports (Phase 11+), automated journal entry generation (deliberate non-goal — see PRODUCT_STRATEGY.md), API access for ERP integrations (defer), white-label report branding (defer to Business tier evolution), AI-suggested IBR/discount rate based on workspace history (defer).

This is the phase that closes the product loop. After Phase 8, a customer can upload a lease, verify the extracted data, and download a structured deliverable that their CPA, their AI tool, or their ERP can use to generate ASC 842 journal entries. Everything before Phase 8 was governance and workflow; Phase 8 is the artifact customers actually buy LeaseIO for.

The report is **not** financial statement output. It is a structured data package designed to be fed into something else. That distinction is foundational — see PRODUCT_STRATEGY.md for the rationale and the liability-protection logic.

---

## Goals of this phase

1. Generate per-lease ASC 842 disclosure reports as PDF and JSON. The PDF is for human review and CPA hand-off; the JSON is for downstream automation (AI tools, ERPs, custom scripts).
2. Generate per-period multi-lease portfolio reports covering all active leases for a given month, quarter, or year. Used for periodic disclosure and audit prep.
3. Each report carries the full verification audit trail — who confirmed which field when, with what timestamp and any override reason.
4. Each material data point in the report cites the source clause and page number from the original lease document.
5. The report is watermarked and clearly framed as "LeaseIO Data Report — Not a Financial Statement" to keep liability where it belongs.
6. Report generation is gated on lease state — only `model_locked` leases (verified, finalized) appear in reports. Drafts, in-flight, and unverified leases are explicitly excluded.
7. Reports are exportable, downloadable, and stored for retrieval. A new bucket holds the generated PDF artifacts.
8. Workspace admins can configure report-level defaults (organization name as it appears on the report, fiscal year start month, default rounding precision).

---

## Database migrations

Create one migration file: `<timestamp>_phase8_disclosure_reports.sql`.

### `lease_reports` table

```sql
CREATE TABLE public.lease_reports (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  report_type                 text NOT NULL CHECK (report_type IN ('lease_disclosure', 'portfolio_period')),
  report_scope                text NOT NULL CHECK (report_scope IN ('single_lease', 'monthly', 'quarterly', 'annual', 'custom_range')),
  lease_id                    uuid REFERENCES public.leases(id) ON DELETE CASCADE,
  period_start                date,
  period_end                  date,
  generated_at                timestamptz NOT NULL DEFAULT now(),
  generated_by                uuid NOT NULL REFERENCES auth.users(id),
  pdf_storage_path            text,
  json_storage_path           text,
  lease_count                 integer NOT NULL DEFAULT 0,
  excluded_lease_count        integer NOT NULL DEFAULT 0,
  exclusion_reasons           jsonb NOT NULL DEFAULT '{}'::jsonb,
  organization_name_at_gen    text,
  discount_rate_method_at_gen text,
  workspace_settings_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'ready', 'failed', 'expired')),
  error_message               text,
  expires_at                  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_scope_lease_id_correlation CHECK (
    (report_scope = 'single_lease' AND lease_id IS NOT NULL AND period_start IS NULL AND period_end IS NULL)
    OR
    (report_scope IN ('monthly', 'quarterly', 'annual', 'custom_range') AND lease_id IS NULL AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_start <= period_end)
  )
);

CREATE INDEX idx_lease_reports_workspace_chronological
  ON public.lease_reports(workspace_id, generated_at DESC);

CREATE INDEX idx_lease_reports_lease
  ON public.lease_reports(lease_id, generated_at DESC)
  WHERE lease_id IS NOT NULL;

CREATE INDEX idx_lease_reports_period
  ON public.lease_reports(workspace_id, period_start, period_end)
  WHERE period_start IS NOT NULL;
```

Notes on schema:

- `report_type` distinguishes single-lease disclosure from portfolio-period roll-ups. Both render to PDF + JSON with the same authoring code path but different sections.
- `report_scope` is the period granularity. Single-lease reports always have `single_lease` scope; period reports must declare their scope so consumers know what they're looking at.
- `pdf_storage_path` and `json_storage_path` point to objects in the new `lease-reports` bucket. Both are generated for every report.
- `lease_count` and `excluded_lease_count` capture portfolio-report metadata — a customer reading the report needs to know "this covers 47 leases; 3 were excluded."
- `exclusion_reasons` is JSON of the form `{"unverified": [lease_id_1, lease_id_2], "draft_state": [lease_id_3]}` so the customer can see exactly which leases were left out and why.
- `organization_name_at_gen` and `discount_rate_method_at_gen` snapshot workspace-level settings at the moment of generation — the report should be reproducible even if those settings change later.
- `workspace_settings_snapshot` captures the full set of relevant settings (fiscal year start, rounding, etc.) for forensic reproducibility.
- `status` tracks generation lifecycle. PDFs take seconds to generate but the architecture supports async; the UI shows a spinner until `ready`.
- `expires_at` is for scheduled cleanup of generated artifacts. Default 90 days post-generation; admin-configurable per workspace.

### `lease_field_verifications` view

The verification audit trail already exists implicitly in the data (the `verifiedFields` Set in `LeaseReview.tsx`, the `confirmedSections` array on `leases`, the `field_corrections` table). Phase 8 introduces a unified view to present this consistently in reports:

```sql
CREATE OR REPLACE VIEW public.v_lease_verification_audit AS
SELECT
  l.id AS lease_id,
  l.workspace_id,
  l.confirmed_sections,
  l.model_locked,
  l.model_locked_at,
  l.model_locked_by,
  l.lease_classification_set_at,
  l.lease_classification_set_by,
  l.discount_rate,
  l.signator_attestation,
  l.signator_approved_at,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'field_id', fc.field_id,
      'original_value', fc.original_value,
      'corrected_value', fc.corrected_value,
      'correction_type', fc.correction_type,
      'corrected_at', fc.corrected_at,
      'corrected_by', fc.corrected_by,
      'ai_confidence_at_correction', fc.ai_confidence_at_correction
    ) ORDER BY fc.corrected_at)
    FROM public.field_corrections fc
    WHERE fc.lease_id = l.id),
    '[]'::jsonb
  ) AS field_corrections
FROM public.leases l;
```

This view is the single source of truth for "what was verified on this lease and by whom." Report generation reads from it directly.

### Workspace report settings

```sql
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS report_organization_name        text,
  ADD COLUMN IF NOT EXISTS report_fiscal_year_start_month  integer NOT NULL DEFAULT 1
    CHECK (report_fiscal_year_start_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS report_rounding_precision       integer NOT NULL DEFAULT 2
    CHECK (report_rounding_precision BETWEEN 0 AND 6),
  ADD COLUMN IF NOT EXISTS report_artifact_retention_days  integer NOT NULL DEFAULT 90
    CHECK (report_artifact_retention_days BETWEEN 1 AND 730),
  ADD COLUMN IF NOT EXISTS report_default_discount_method  text DEFAULT 'workspace_default'
    CHECK (report_default_discount_method IN ('workspace_default', 'risk_free_rate', 'incremental_borrowing_rate', 'custom'));
```

Defaults are sensible for the most common customer (calendar-year fiscal, 2-decimal rounding, 90-day retention). Admins configure these via the workspace settings page.

### Storage bucket for report artifacts

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('lease-reports', 'lease-reports', false)
ON CONFLICT (id) DO NOTHING;
```

### RLS for `lease_reports`

```sql
ALTER TABLE public.lease_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace members read reports"
  ON public.lease_reports FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

-- Editors and admins can request report generation (the edge function does the actual insert via service role)
CREATE POLICY "members initiate reports"
  ON public.lease_reports FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    AND generated_by = auth.uid()
  );

-- Admins can delete reports (e.g., for cleanup or correction)
CREATE POLICY "admins delete reports"
  ON public.lease_reports FOR DELETE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
```

### Storage RLS for `lease-reports`

Following the established pattern from prior buckets:

```sql
CREATE POLICY "workspace members read lease-reports"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'lease-reports'
    AND EXISTS (
      SELECT 1 FROM public.lease_reports lr
      WHERE (lr.pdf_storage_path = name OR lr.json_storage_path = name)
        AND (
          lr.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
          )
          OR lr.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
        )
    )
  );

CREATE POLICY "service role manages lease-reports"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'lease-reports' AND owner = auth.uid());
```

The service role (edge function) writes the artifacts. Members read.

### Activity log additions

```sql
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- All prior values preserved (Legacy + Phases 2-7) ...
    -- Phase 8 additions
    'report_generation_requested',
    'report_generation_completed',
    'report_generation_failed',
    'report_downloaded',
    'report_expired',
    'report_deleted'
  ));
```

---

## Code changes

### Pure helpers — `src/lib/asc842Report.ts` (new file)

This is the single largest pure-logic file in the codebase. Pure computation only — no I/O, no UI, no edge function specifics. Node-importable and Deno-mirrored.

```typescript
// Stay in sync with supabase/functions/_shared/asc842_report.ts.

export type LeaseClassification = 'operating' | 'finance' | 'pending';

export type RentPeriod = {
  period_start: string;  // ISO date
  period_end: string;
  monthly_amount: number;
  annual_amount: number;
  notes: string | null;
};

export type ReportInputs = {
  lease_id: string;
  workspace_id: string;
  // Identity
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
  discount_rate: number;          // percentage (e.g., 5.5)
  monthly_payment: number | null;
  rent_schedule: RentPeriod[];
  security_deposit: number | null;
  // Computed (precomputed from existing leases columns)
  pv_liability: number | null;
  total_commitment: number | null;
  straight_line_monthly_expense: number | null;
  cash_pl_delta: number | null;
  // Verification trail
  verification_audit: VerificationAuditEntry[];
  signator_attestation: string | null;
  signator_approved_at: string | null;
  model_locked_at: string | null;
  // Citations
  field_citations: Record<string, { snippet: string; page: number }>;
};

export type VerificationAuditEntry = {
  field_id: string;
  original_value: string | null;
  corrected_value: string | null;
  correction_type: 'add_missing' | 'delete_wrong' | 'edit' | 'verified_unchanged';
  corrected_at: string;
  corrected_by_user_label: string;
  ai_confidence_at_correction: number | null;
};

export type ReportSection =
  | { kind: 'identification'; data: IdentificationSection }
  | { kind: 'payment_schedule'; data: PaymentScheduleSection }
  | { kind: 'asc842_inputs'; data: Asc842InputsSection }
  | { kind: 'key_terms'; data: KeyTermsSection }
  | { kind: 'preparer_notes'; data: PreparerNotesSection }
  | { kind: 'verification_audit'; data: VerificationAuditSection };

// Builds the full set of sections for a single-lease disclosure report.
// Pure function — given inputs, returns sections deterministically.
export function buildLeaseDisclosureSections(inputs: ReportInputs): ReportSection[] {
  return [
    { kind: 'identification', data: buildIdentificationSection(inputs) },
    { kind: 'payment_schedule', data: buildPaymentScheduleSection(inputs) },
    { kind: 'asc842_inputs', data: buildAsc842InputsSection(inputs) },
    { kind: 'key_terms', data: buildKeyTermsSection(inputs) },
    { kind: 'preparer_notes', data: buildPreparerNotesSection(inputs) },
    { kind: 'verification_audit', data: buildVerificationAuditSection(inputs) },
  ];
}

// The preparer notes section is the most important automated content.
// It surfaces flags the accountant or AI tool needs to know about before
// generating journal entries.
export function buildPreparerNotesSection(inputs: ReportInputs): PreparerNotesSection {
  const flags: PreparerFlag[] = [];

  if (inputs.lease_classification === 'pending') {
    flags.push({
      severity: 'high',
      title: 'Lease classification not finalized',
      explanation: 'The lease has not been classified as Operating or Finance. ASC 842 treatment differs materially between the two. Please classify before generating journal entries.',
    });
  }

  if (inputs.discount_rate <= 0 || inputs.discount_rate > 50) {
    flags.push({
      severity: 'high',
      title: 'Discount rate out of plausible range',
      explanation: `Discount rate of ${inputs.discount_rate}% is outside the typical IBR range. Verify the rate is correct.`,
    });
  }

  if (inputs.rent_schedule.length === 0) {
    flags.push({
      severity: 'high',
      title: 'No rent schedule recorded',
      explanation: 'The lease has no rent periods. Journal entries cannot be generated without payment information.',
    });
  }

  if (hasRentEscalations(inputs.rent_schedule) && (inputs.straight_line_monthly_expense ?? 0) === 0) {
    flags.push({
      severity: 'medium',
      title: 'Rent escalations present but straight-line expense is zero',
      explanation: 'The lease has escalating rent but no computed straight-line expense. ASC 842 requires straight-lining for operating leases. Verify the calculation.',
    });
  }

  if (inputs.model_locked_at === null) {
    flags.push({
      severity: 'high',
      title: 'Lease not yet finalized',
      explanation: 'This lease has not been model-locked. The data has not passed final verification. Reports against unfinalized leases are draft only.',
    });
  }

  // Tenant improvement allowances and initial direct costs are not extracted by AI.
  flags.push({
    severity: 'medium',
    title: 'Tenant improvement allowances and initial direct costs require manual confirmation',
    explanation: 'LeaseIO does not extract tenant improvement allowances or initial direct costs from lease documents. Confirm these manually before generating journal entries.',
  });

  return { flags, generated_at: new Date().toISOString() };
}

// Returns true if the rent schedule contains escalating periods.
function hasRentEscalations(schedule: RentPeriod[]): boolean {
  for (let i = 1; i < schedule.length; i++) {
    if (schedule[i].monthly_amount !== schedule[i - 1].monthly_amount) return true;
  }
  return false;
}

// Builds the JSON output. The JSON is the structured data file the customer
// hands to their AI tool or ERP. It must be self-contained, complete, and
// schema-stable across versions.
export function buildLeaseDisclosureJson(inputs: ReportInputs): object {
  return {
    schema_version: '1.0.0',
    report_metadata: {
      lease_id: inputs.lease_id,
      workspace_id: inputs.workspace_id,
      generated_at: new Date().toISOString(),
      report_type: 'lease_disclosure',
      not_a_financial_statement: true,
      liability_disclaimer: 'This report contains structured lease data. It is not a financial statement and does not constitute accounting advice. The customer is responsible for using this data correctly in their accounting and reporting.',
    },
    lease_identification: { /* ... */ },
    payment_schedule: inputs.rent_schedule,
    asc842_inputs: { /* ... */ },
    key_terms: { /* ... */ },
    preparer_notes: buildPreparerNotesSection(inputs),
    verification_audit: inputs.verification_audit,
    signator_attestation: {
      attestation_text: inputs.signator_attestation,
      signed_at: inputs.signator_approved_at,
    },
    field_citations: inputs.field_citations,
  };
}

// Builds a portfolio-period report from many lease inputs.
// Aggregates totals, surfaces per-lease summaries, and includes preparer
// notes at the portfolio level for cross-cutting concerns.
export function buildPortfolioPeriodReport(
  leases: ReportInputs[],
  period: { start: string; end: string },
  workspaceContext: WorkspacePortfolioContext,
): PortfolioReport {
  // ... aggregation logic
}
```

The Deno mirror at `supabase/functions/_shared/asc842_report.ts` carries identical logic.

### New edge function: `generate-lease-report`

Generates a single-lease disclosure report.

1. Verify the actor has access to the lease.
2. Verify the lease is `model_locked` (Phase 8 reports only finalized leases). If not, return clear error.
3. Insert a `lease_reports` row with `status = 'generating'`.
4. Insert `report_generation_requested` activity log entry on the lease.
5. Load all required inputs (lease, rent_schedules, field_corrections, verification audit view, citation snippets from extraction metadata).
6. Build sections via `buildLeaseDisclosureSections()`.
7. Build JSON via `buildLeaseDisclosureJson()`. Upload to `lease-reports/{workspace_id}/{report_id}/data.json`.
8. Render PDF (see below). Upload to `lease-reports/{workspace_id}/{report_id}/report.pdf`.
9. Update `lease_reports` row: `status = 'ready'`, storage paths populated.
10. Insert `report_generation_completed` activity log entry.
11. Return the report ID for the frontend to poll/redirect.

On failure, set `status = 'failed'`, populate `error_message`, log the failure activity. The frontend surfaces the error to the user.

### New edge function: `generate-portfolio-report`

Generates a portfolio-period report for all eligible leases in a workspace covering a period.

1. Verify the actor is a workspace admin or editor.
2. Validate period inputs.
3. Insert `lease_reports` row.
4. Query leases in the workspace where:
   - `model_locked = true`
   - `lifecycle_status = 'active'`
   - Period overlaps with lease term (commencement_date < period_end AND expiration_date > period_start)
5. For each excluded lease, capture the reason in `exclusion_reasons`. Common reasons: `not_model_locked`, `not_active`, `period_no_overlap`, `verification_incomplete`.
6. Build per-lease report inputs.
7. Aggregate via `buildPortfolioPeriodReport()`.
8. Render JSON and PDF.
9. Same status update + activity logging.

### PDF rendering

Use the existing `@react-pdf/renderer` library (already in `package.json`). Build a new component tree at `src/lib/reports/leaseDisclosurePdf.tsx` that consumes `ReportSection[]` and renders to PDF.

Sections render as:
- **Header** — workspace org name, lease title, "LeaseIO Data Report — Not a Financial Statement" watermark band
- **Identification** — table of identity fields with citation footnotes
- **Payment Schedule** — full rent table with dates, amounts, totals
- **ASC 842 Inputs** — the five computed inputs in a clean table
- **Key Terms** — escalation, renewal, termination, security deposit
- **Preparer Notes** — flagged in colored boxes by severity
- **Verification Audit** — chronological entries of every confirmed field
- **Footer** — generation timestamp, report ID, page count

PDF generation runs server-side in the edge function via React PDF's renderer API, producing a binary buffer that gets uploaded to storage.

### Frontend — single lease report generation UI

On the lease detail page, when `model_locked = true`, a new "Generate Report" button appears in the action cluster.

Clicking it:
1. Opens a confirmation modal: "Generate ASC 842 Disclosure Report for [lease title]?" with a brief explainer of what the report contains and the LeaseIO/customer liability disclaimer.
2. On confirm, calls `generate-lease-report`.
3. Shows a spinner with "Generating report..."
4. Polls the report status. When `ready`, redirects to the report detail page.

The report detail page at `/app/leases/{lease_id}/reports/{report_id}` shows:
- Report metadata (generated when, by whom, status)
- "Download PDF" and "Download JSON" buttons
- Embedded PDF preview (using `@react-pdf/renderer`'s viewer)
- A clear callout: "This report is structured lease data, not a financial statement. Use it as input for your accounting tools or share with your CPA."
- Re-generation button (admin only, for the case where data was corrected post-report)

### Frontend — portfolio report UI

A new admin page at `/app/admin/reports`:
- Date range picker (with shortcuts for common periods: Q4 2026, January 2026, FY2026)
- Period scope selector (monthly, quarterly, annual, custom)
- "Generate Report" button → calls `generate-portfolio-report`
- List of historical reports with status, period covered, lease count, download buttons
- Filters for finding past reports

### Frontend — workspace report settings

A new section in workspace settings under existing tabs:
- Organization name (defaults to workspace name; admins can override for report formatting)
- Fiscal year start month (1-12)
- Rounding precision (0-6 decimals)
- Report artifact retention days (1-730)
- Default discount rate methodology label

### Frontend — report library

A list view at `/app/reports` showing all reports the user has access to in the current workspace, sortable by date, type, and lease. Both single-lease and portfolio reports.

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- `lease_reports` constraints enforce single_lease has lease_id but no period; period scopes have period but no lease_id.
- View `v_lease_verification_audit` returns correct shape for fixtures.
- New activity types accepted.

### Pure logic (vitest) — extensive

`buildLeaseDisclosureSections`:
- Returns six sections in correct order.
- Each section returns expected data shape.
- Identification section pulls correct fields.
- Payment schedule reflects rent_schedule input.
- ASC 842 inputs section uses precomputed values.

`buildPreparerNotesSection`:
- Flags `pending` classification with high severity.
- Flags out-of-range discount rate.
- Flags missing rent schedule.
- Flags rent escalations without straight-line.
- Flags non-locked leases.
- Always flags TI allowance / initial direct cost manual review.

`buildLeaseDisclosureJson`:
- Output matches schema version 1.0.0.
- Contains liability disclaimer.
- Includes verification audit.
- Includes citations.

`buildPortfolioPeriodReport`:
- Aggregates totals correctly.
- Per-lease summaries included.
- Excluded leases captured with reasons.

### Edge function

`generate-lease-report`:
- Locked lease → report generated, both PDF and JSON uploaded.
- Unlocked lease → rejected with clear error.
- Non-workspace member → 403.
- Activity logged on success and failure.

`generate-portfolio-report`:
- Includes only model_locked + active leases overlapping the period.
- Exclusion reasons captured for excluded leases.
- Returns clear error on no eligible leases.

### Frontend (vitest)

- Generate Report button only appears for model_locked leases.
- Modal shows liability disclaimer.
- Polling resolves when report is ready.
- Download buttons trigger correct artifact downloads.
- Portfolio report period picker validates date ranges.

### Manual smoke

- Generate single-lease report, download both PDF and JSON, open both, verify contents match the lease data.
- Verify citations point to correct page/clause in the source document.
- Verify watermark "Not a Financial Statement" is visible.
- Verify verification audit shows correct user/timestamp for each confirmation.
- Generate portfolio period report covering 5+ leases, verify aggregation.
- Verify exclusion reasons appear when leases are excluded.

---

## Out of scope for Phase 8 — explicit list

Do NOT build any of these in Phase 8.

- Automated journal entry generation. This is a deliberate non-goal — see PRODUCT_STRATEGY.md for the liability rationale.
- API access for ERP integrations to pull report data. Defer.
- Webhook-based report delivery (e.g., post-generation push to Slack, email). Defer to a future enhancement.
- White-label report branding (custom logos, colors, headers). Could be a Business tier add-on later.
- AI-suggested IBR/discount rate based on workspace history. Defer.
- Comparative reporting (this period vs. last period, this lease vs. comparable leases). Defer.
- Excel/CSV export formats. JSON is the structured machine-readable format; Excel is downstream. Defer.
- Report versioning beyond the simple "generated at" timestamp. If a customer regenerates, they get a new report record. No diff between versions; no rollback to prior version. Defer.
- Reproducible report regeneration (i.e., "regenerate this exact report from 6 months ago"). Reports are deterministic given inputs but inputs may have changed. The artifact is the snapshot. Defer.
- Firm-layer cross-workspace roll-ups (CPA firm sees all clients' reports). Phase 11+.
- Direct integrations with FinQuery, Visual Lease, or other lease accounting tools. Strategic non-goal — LeaseIO is the upstream layer.

---

## Definition of done for Phase 8

1. Migration applied cleanly. All schema, view, RLS tests pass. Mirror committed.
2. Pure helpers in `src/lib/asc842Report.ts` and Deno mirror with full unit tests passing.
3. Two new edge functions deployed: `generate-lease-report`, `generate-portfolio-report`. PDF rendering verified end-to-end.
4. Frontend single-lease report flow working: button, modal, generation, viewing, download.
5. Frontend portfolio report flow working: admin page, period picker, generation, list, download.
6. Workspace report settings section added.
7. Report library view at `/app/reports` lists historical reports with filters.
8. Manual smoke completed:
   - Generate report for a verified active lease, verify PDF and JSON contents
   - Generate portfolio report for a quarter, verify aggregation and exclusions
   - Verify watermark and liability disclaimer prominently displayed
   - Verify citations are clickable/visible and link to correct source pages
   - Verify verification audit captures all confirmed fields with timestamps
9. RLS verified — non-member cannot read reports, non-admin cannot delete.
10. As-built notes appendix on this spec captures any deltas discovered during implementation.
11. Phase closeout commit body lists every commit, migration, edge function deployment, and test added.
12. KNOWN_ISSUES.md updated.
13. CLAUDE.md updated to mark Phase 8 closed and Phase 9 (Firm Layer) next.

---

## Notes for Claude Code

- This phase produces the artifact customers actually buy LeaseIO for. The user-facing quality of the report (PDF design, JSON schema clarity, preparer notes accuracy) directly affects whether the product is sellable. Don't optimize for elegance; optimize for "would a CPA use this?"
- The PDF design matters more than for any prior phase. Use the existing `frontend-design` patterns. The report should look professional, not engineered — closer to what a Big Four firm would produce than what a SaaS tool typically generates.
- The watermark "LeaseIO Data Report — Not a Financial Statement" must be visible on every page of the PDF, not just the cover. This is the liability protection — make it impossible to miss even if the user crops or screenshots.
- The JSON schema is a contract with downstream consumers. Once shipped, future changes must be backward-compatible or carry a `schema_version` bump. Document the schema in `docs/JSON_REPORT_SCHEMA.md` so customers integrating with it have a stable reference.
- The preparer notes section is where LeaseIO adds the most value. Each flag should be specific, actionable, and grounded in real ASC 842 considerations. Don't generate generic flags — generate ones a CPA would actually use.
- The verification audit section is the liability shield. Every material field must trace back to a user, timestamp, and original AI value. If audit data is incomplete for a field, the field is omitted from the report rather than reported without provenance.
- Citation handling is non-trivial. The extraction pipeline produces page numbers and clause snippets per field; reports need to surface these. Where citation data is missing, the report says so explicitly rather than hiding the gap.
- Reuse the same checkpoint cadence as Phase 7:
  - Checkpoint 1: Migration + types regen + audit
  - Checkpoint 2: Pure helpers (the largest pure logic file in the codebase) + Deno mirror + vitest
  - Checkpoint 3: Edge functions + PDF rendering + smoke
  - Checkpoint 4: Frontend (single-lease, portfolio, settings, library)
  - Checkpoint 5: Tests + docs + closeout + manual end-to-end smoke
- Apply the Schema Change Rule, Permissions Gating Convention, and Lifecycle Transition Convention.
- Reference `docs/PRODUCT_STRATEGY.md` — Phase 8 features are foundational to all three tiers. Plus tier gets single-lease reports only with limited portfolio reporting; Pro tier gets full portfolio capabilities; Business tier inherits Pro and (in Phase 11+) adds firm-level roll-ups.
- Do not introduce new dependencies beyond what's already in `package.json`. `@react-pdf/renderer` is the PDF library; don't substitute.
- The PDF generation in the edge function may be slow for very large portfolio reports. Phase 8 ships with synchronous generation; if real-world usage shows timeouts, a future enhancement can move to background-queue generation. Design the table for that future migration: `status: 'generating'` + polling pattern is already in place.
- Reports stored in storage are subject to retention. After `expires_at`, a future cleanup job will mark them `status = 'expired'` and purge the artifacts. Phase 8 does not implement the cleanup job; it just records `expires_at` for future use. KNOWN_ISSUES gets a marker for this.

---

## As-built notes (placeholder, populated at close)

Spec ↔ implementation deltas to be captured here at Checkpoint 5 close, citing this spec doc by SHA per the audit-doc inheritance rule.
