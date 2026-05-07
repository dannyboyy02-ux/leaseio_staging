# LeaseIO ASC 842 Disclosure Report — JSON Schema

**Schema version:** `1.0.0` (introduced 2026-05-06, Phase 8)
**Source-of-truth code:** `src/lib/asc842Report.ts` ↔ `supabase/functions/_shared/asc842_report.ts` (Deno mirror)
**Producer functions:** `buildLeaseDisclosureJson` (single lease) and `buildPortfolioPeriodReport` (period roll-up)
**Edge functions:** `generate-lease-report`, `generate-portfolio-report`

---

## Purpose

The JSON output is the structured-data half of LeaseIO's ASC 842 deliverable. The PDF is for human review and CPA hand-off; this JSON is the machine-readable feed for downstream automation — accountant-side scripts, an ERP's lease module, an AI agent generating journal entries, etc.

This document is the **stable contract**. The producers in `asc842Report.ts` are the binding implementation; this file describes what they emit and what guarantees the consumer can rely on.

## Stability rules

- **Schema versioning is semantic.** `schema_version` is a string of the form `MAJOR.MINOR.PATCH`.
  - **MAJOR** bump when an existing field is renamed, removed, or its type changes incompatibly.
  - **MINOR** bump when fields are added (consumers built for an earlier minor version stay compatible — fields are additive).
  - **PATCH** bump for non-schema bug fixes that may shift values but not structure.
- Every change to the producer functions that affects emitted JSON requires a corresponding bump here AND an update to this document.
- A JSON consumer SHOULD branch on `schema_version` major and warn if it sees a major it does not understand.

## Liability framing

Every report carries this protection in `report_metadata`:
- `not_a_financial_statement: true` — a hard boolean. Consumers MUST surface this to humans before producing financial statements.
- `liability_disclaimer` — full prose. Consumers SHOULD render this verbatim if displaying the report to humans.
- `banner` — short string for header / watermark display.

LeaseIO's role is data extraction, verification, and audit trail. The customer (or their CPA) is solely responsible for using the data correctly in financial reporting. This is captured in product copy, the PDF watermark, the JSON, and `docs/PRODUCT_STRATEGY.md`.

---

## Single-lease disclosure report

Top-level shape:

```jsonc
{
  "schema_version": "1.0.0",
  "report_metadata": { ... },
  "lease_identification": { ... },
  "payment_schedule": { ... },
  "asc842_inputs": { ... },
  "key_terms": { ... },
  "preparer_notes": { ... },
  "verification_audit": { ... },
  "field_citations": { ... }
}
```

### `report_metadata`

```jsonc
{
  "lease_id": "uuid",                  // matches public.leases.id
  "workspace_id": "uuid",              // matches public.workspaces.id
  "generated_at": "2026-05-06T20:30:11.123Z",
  "report_type": "lease_disclosure",   // enum
  "not_a_financial_statement": true,   // always true
  "liability_disclaimer": "...",       // full prose
  "banner": "LeaseIO Data Report — Not a Financial Statement"
}
```

### `lease_identification`

```jsonc
{
  "fields": [
    {
      "field_id": "tenant_name",
      "label": "Tenant",
      "value": "Acme Inc" | null,
      "citation": { "snippet": "...", "page": 1 } | null
    },
    /* one entry per identity field; fields are emitted in the
       canonical order:
         tenant_name, landlord_name, property_address, asset_type,
         execution_date, commencement_date, rent_commencement_date,
         expiration_date, term_months
       — date and term values are stringified for downstream
       consistency with the citation contract. */
  ]
}
```

### `payment_schedule`

```jsonc
{
  "periods": [
    {
      "period_start": "2026-01-01",
      "period_end":   "2026-12-31",
      "monthly_amount": 10000,
      "annual_amount":  120000,
      "notes": null
    }
  ],
  "total_periods": 2,
  "total_cash_commitment": 243600 | null,
  "has_escalations": true,
  "citation": { "snippet": "...", "page": 4 } | null
}
```

### `asc842_inputs`

```jsonc
{
  "classification": "operating" | "finance" | "pending",
  "classification_set_at": "2026-04-02T09:00:00Z" | null,
  "classification_set_by": "jane.cpa@acme.test" | null,
  "discount_rate_percent": 5.5,
  "pv_liability": 230000 | null,
  "total_commitment": 243600 | null,
  "straight_line_monthly_expense": 10150 | null,
  "cash_pl_delta": 0 | null,
  "term_months": 24 | null,
  "commencement_date": "2026-01-01" | null,
  "expiration_date":   "2027-12-31" | null
}
```

### `key_terms`

```jsonc
{
  "security_deposit": 20000 | null,
  "security_deposit_citation": { "snippet": "...", "page": 5 } | null,
  "rent_commencement_date": "2026-01-01" | null,
  "execution_date":         "2025-12-15" | null,
  "asset_type":             "property" | null,
  "escalation_clause": {
    "type": "fixed_percent" | "cpi" | "fixed_amount" | "stepped" | "none" | null,
    "rate": 3 | null,
    "notes": null
  } | null,
  "escalation_citation": { ... } | null,
  "renewal_options": [
    {
      "option_term_months": 60 | null,
      "notice_required_days": 180 | null,
      "notes": "Tenant exercise" | null
    }
  ],
  "renewal_citation": { ... } | null,
  "termination_clause": {
    "early_termination_allowed": true | false | null,
    "notice_days": 90 | null,
    "penalty_amount": 50000 | null,
    "notes": null
  } | null,
  "termination_citation": { ... } | null
}
```

### `preparer_notes`

```jsonc
{
  "flags": [
    {
      "severity": "low" | "medium" | "high",
      "title": "...",          // short, actionable
      "explanation": "..."     // 1-3 sentences
    }
  ],
  "generated_at": "2026-05-06T20:30:11.123Z"
}
```

Flags are produced by `buildPreparerNotesSection`. The list is deterministic given the inputs; consumers can rely on the same input producing the same flag set.

**Rule set as of schema 1.0.0:**

| # | Severity | Title (prefix) | Trigger |
|---|---|---|---|
| 1 | high | "Lease classification not finalized" | `lease_classification === 'pending'` |
| 2 | high | "Discount rate out of plausible range" | rate ≤ 0, > 50, or non-finite |
| 3 | high | "No rent schedule recorded" | empty `rent_schedule` |
| 4 | medium | "Rent escalations present but straight-line expense is zero" | escalating periods + SL = 0 |
| 5 | high | "Lease not yet finalized" | `model_locked_at === null` |
| 6 | high | "Commencement date is after expiration date" | inverted dates |
| 7 | medium | "Short-term lease — ASC 842 election may apply" | term ≤ 12 months and classification not pending |
| 8 | medium | "Tenant improvement allowances and initial direct costs require manual confirmation" | always |

A consumer MAY filter by severity but SHOULD NOT suppress an entire severity level — the rule set is intentionally narrow, and each rule represents a real-world ASC 842 consideration a CPA would expect to see.

### `verification_audit`

```jsonc
{
  "entries": [
    {
      "field_id": "tenant_name",
      "original_value": "Acme Inc" | null,
      "corrected_value": "Acme Inc" | null,
      "correction_type": "add_missing" | "delete_wrong" | "edit" | "verified_unchanged",
      "corrected_at": "2026-04-01T10:00:00Z",
      "corrected_by_user_label": "jane.cpa@acme.test",
      "ai_confidence_at_correction": 0.97 | null
    }
  ],
  "total_corrections": 12,            // sum of non-`verified_unchanged`
  "total_verified_unchanged": 4,
  "signator_attestation": {
    "attestation_text": "Reviewed all material terms; no further negotiation required." | null,
    "signed_at": "2026-04-15T15:00:00Z" | null
  },
  "model_locked": {
    "locked_at": "2026-04-20T11:00:00Z" | null,
    "locked_by": "admin@acme.test" | null
  }
}
```

This is the audit-defensible part of the report — every material field traces back to a user, timestamp, and original AI value. **A field with no audit entry SHOULD be considered un-verified by downstream consumers.**

### `field_citations`

A `Record<field_id, { snippet: string; page: number }>` of source-document citations. Keyed by the same `field_id` values that appear in `lease_identification.fields[*].field_id`, `key_terms.security_deposit_citation`, etc. Consumers can use this map directly to render hover-cards or tooltips. Missing keys MUST be treated as "no citation captured."

---

## Portfolio-period report

Emitted by `buildPortfolioPeriodReport`. Same `schema_version` (`1.0.0`).

```jsonc
{
  "schema_version": "1.0.0",
  "report_metadata": {
    "workspace_id": "uuid",
    "organization_name": "Acme Inc",
    "period_start": "2026-01-01",
    "period_end":   "2026-03-31",
    "generated_at": "2026-05-06T20:30:11.123Z",
    "report_type": "portfolio_period",
    "not_a_financial_statement": true,
    "liability_disclaimer": "...",
    "fiscal_year_start_month": 1,
    "rounding_precision": 2,
    "discount_rate_method": "incremental_borrowing_rate"
  },
  "totals": {
    "lease_count": 47,
    "excluded_count": 3,
    "total_pv_liability":   1234567,
    "total_commitment":     2345678,
    "total_monthly_straight_line": 99000,
    "operating_lease_count": 42,
    "finance_lease_count": 4,
    "pending_classification_count": 1
  },
  "per_lease_summaries": [
    {
      "lease_id": "uuid",
      "tenant_name": "..." | null,
      "property_address": "..." | null,
      "classification": "operating" | "finance" | "pending",
      "pv_liability": 100000 | null,
      "total_commitment": 120000 | null,
      "straight_line_monthly_expense": 10000 | null,
      "commencement_date": "2026-01-01" | null,
      "expiration_date":   "2027-12-31" | null,
      "flag_count": 2,
      "high_severity_flag_count": 1
    }
  ],
  "exclusions": [
    {
      "reason": "not_model_locked" | "not_active" | "period_no_overlap" | "verification_incomplete" | "other",
      "lease_ids": ["uuid", ...],
      "count": 3
    }
  ],
  "preparer_notes": { /* same shape as single-lease */ }
}
```

### Eligibility criteria for inclusion

A lease appears in `per_lease_summaries` (and contributes to `totals`) if and only if:

1. `model_locked = true`
2. `lifecycle_status = 'active'`
3. The lease's term overlaps the report period: `commencement_date ≤ period_end AND expiration_date ≥ period_start`
4. Verification is considered complete (currently: `model_locked` + non-empty `confirmed_sections`)

Otherwise the lease appears in `exclusions` with the reason that fired first in priority order: `not_model_locked > not_active > period_no_overlap > verification_incomplete`. Consumers SHOULD surface excluded leases with their reason rather than silently dropping them.

### Portfolio preparer notes

In addition to the single-lease rule set, the portfolio variant adds:

- `"No eligible leases in period"` (high) — when `lease_count === 0`.
- `"N lease(s) with unfinalized classification"` (high)
- `"N lease(s) with implausible discount rate"` (high)
- `"N lease(s) without rent schedule"` (medium)
- `"N lease(s) excluded from totals"` (medium) — references the `exclusions` array.
- `"Period covered"` (low) — informational; restates the period bounds.

---

## Producer / consumer guarantees

| Guarantee | Means for consumers |
|---|---|
| Output is deterministic given inputs | Re-running the same lease at the same data state produces equivalent JSON (modulo `report_metadata.generated_at` and `preparer_notes.generated_at`). |
| `field_id` keys are stable | Once shipped, a `field_id` value will not be renamed without a major version bump. |
| Citations are best-effort | Many fields will have `citation: null` because the AI pipeline did not capture a snippet. Consumers MUST handle null citations gracefully. |
| Verification audit is the integrity boundary | If `verification_audit.entries` is empty, treat the report as draft-quality. Same for `model_locked.locked_at = null`. |
| Numbers may exceed display precision | The producer rounds for display only inside the PDF. JSON values are the underlying floats. Consumers SHOULD apply `report_metadata.rounding_precision` (portfolio) or workspace defaults when displaying. |

## Adding a new field (for future LeaseIO contributors)

1. Add the field to the relevant `ReportInputs` / `*Section` type in `src/lib/asc842Report.ts`.
2. Update the matching producer (`buildLeaseDisclosureJson`, `buildPortfolioPeriodReport`, etc.).
3. Mirror to the Deno copy at `supabase/functions/_shared/asc842_report.ts`.
4. Bump `REPORT_SCHEMA_VERSION` (minor for additive, major for breaking).
5. Update this document with the new field, its type, and any consumer notes.
6. Add or extend the corresponding vitest case in `src/lib/__tests__/asc842Report.test.ts`.

---

## Versions

| Version | Date | Notes |
|---|---|---|
| 1.0.0 | 2026-05-06 | Initial release (Phase 8 closeout). Single-lease + portfolio-period reports. 8 single-lease preparer-note rules + 6 portfolio-level rules. |
