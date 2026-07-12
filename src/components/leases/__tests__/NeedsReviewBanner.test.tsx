// @vitest-environment jsdom
import '../../workspace/__tests__/_jsdomPolyfills';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Regression coverage for the B1 fix + its polish follow-up. NeedsReviewBanner
// was rewritten to read per-field confidence from the live `extracted_json` via
// getFieldConfidence (cutoff = LOW_CONFIDENCE_THRESHOLD/100 = 0.80) instead of
// the never-populated `lease.confidence_scores` column — so the low-confidence
// warning could never fire before. This pins:
//   - a present field below the cutoff is flagged with its rounded percentage,
//   - a present field at/above the cutoff is NOT flagged,
//   - a missing (falsy) field is surfaced as "missing",
//   - all-good renders nothing (the component returns null),
//   - the 0.80 boundary: 0.80 not flagged, 0.79 flagged,
//   - the icon severity matches the per-field ConfidenceBadge tiers: red
//     (XCircle / text-destructive) below 70%, amber (text-amber-500) for 70–80%.
//
// Note: NeedsReviewBanner imports getFieldConfidence/confidenceTier from the
// pure `@/lib/extractedFieldHelpers` module — NOT the supabase client. This
// test mounting cleanly is itself part of the contract.

// Echo the i18n key (+ interpolated params) so assertions match on keys rather
// than translated copy — the repo convention (see PlanPickerDialog.test.tsx).
vi.mock('@/hooks/useAppTranslation', () => ({
  useAppTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        // Mirror real i18next: a bare { defaultValue } lookup (the nested
        // field-label resolution) falls back to the default string, so the
        // outer echo stays readable ("label=Landlord Name").
        const { defaultValue, ...rest } = opts as { defaultValue?: unknown };
        const params = Object.entries(rest)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',');
        if (params) return `${key}(${params})`;
        if (defaultValue !== undefined) return String(defaultValue);
        return key;
      }
      return key;
    },
  }),
}));

import { NeedsReviewBanner } from '../NeedsReviewBanner';

afterEach(cleanup);

// All four Tier-1 fields present + high-confidence, so a test can perturb a
// single field and assert only that field drives the banner.
const ALL_PRESENT = {
  landlordName: 'Acme LLC',
  tenantName: 'Beta Corp',
  leaseStart: '2026-01-01',
  leaseEnd: '2027-01-01',
} as const;

const HIGH_CONF_JSON = {
  landlord_name: { value: 'Acme LLC', confidence: 0.99 },
  tenant_name: { value: 'Beta Corp', confidence: 0.99 },
  lease_start: { value: '2026-01-01', confidence: 0.99 },
  lease_end: { value: '2027-01-01', confidence: 0.99 },
};

describe('NeedsReviewBanner — low-confidence flagging', () => {
  it('flags a present field with confidence 0.55, rendering the rounded percentage', () => {
    render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          landlord_name: { value: 'Acme LLC', confidence: 0.55 },
        }}
      />,
    );
    expect(screen.getByText('needs_review.title')).toBeTruthy();
    expect(
      screen.getByText('needs_review.low_confidence(label=Landlord Name,pct=55)'),
    ).toBeTruthy();
  });

  it('does NOT flag a present field with high confidence (0.95)', () => {
    const { container } = render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          landlord_name: { value: 'Acme LLC', confidence: 0.95 },
        }}
      />,
    );
    // No issues at all -> the component renders nothing.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('needs_review.title')).toBeNull();
  });
});

describe('NeedsReviewBanner — missing fields', () => {
  it('surfaces a missing (falsy) field as "missing"', () => {
    render(
      <NeedsReviewBanner
        landlordName={null}
        tenantName="Beta Corp"
        leaseStart="2026-01-01"
        leaseEnd="2027-01-01"
        extractedJson={HIGH_CONF_JSON}
      />,
    );
    expect(screen.getByText('needs_review.title')).toBeTruthy();
    expect(screen.getByText('needs_review.missing(label=Landlord Name)')).toBeTruthy();
    // A missing field is reported as missing, never as low-confidence.
    expect(screen.queryByText(/needs_review\.low_confidence/)).toBeNull();
  });
});

describe('NeedsReviewBanner — all good', () => {
  it('renders nothing when every Tier-1 field is present and high-confidence', () => {
    const { container } = render(
      <NeedsReviewBanner {...ALL_PRESENT} extractedJson={HIGH_CONF_JSON} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('NeedsReviewBanner — 0.80 cutoff boundary', () => {
  it('does NOT flag a field exactly at the 0.80 cutoff', () => {
    const { container } = render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          tenant_name: { value: 'Beta Corp', confidence: 0.80 },
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('flags a field just below the cutoff (0.79 -> "pct=79")', () => {
    render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          tenant_name: { value: 'Beta Corp', confidence: 0.79 },
        }}
      />,
    );
    expect(
      screen.getByText('needs_review.low_confidence(label=Tenant Name,pct=79)'),
    ).toBeTruthy();
  });

  it("treats a 'medium' string confidence (0.80) as at-cutoff -> not flagged", () => {
    const { container } = render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          tenant_name: { value: 'Beta Corp', confidence: 'medium' },
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("treats a 'low' string confidence (0.60) as below cutoff -> flagged (60%)", () => {
    render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          tenant_name: { value: 'Beta Corp', confidence: 'low' },
        }}
      />,
    );
    expect(
      screen.getByText('needs_review.low_confidence(label=Tenant Name,pct=60)'),
    ).toBeTruthy();
  });
});

describe('NeedsReviewBanner — icon severity matches the field badge tiers', () => {
  it('uses a red icon below 70% and an amber icon for 70–80%', () => {
    render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          landlord_name: { value: 'Acme LLC', confidence: 0.55 }, // tier low -> red
          tenant_name: { value: 'Beta Corp', confidence: 0.75 }, // tier medium -> amber
        }}
      />,
    );

    const lowLi = screen
      .getByText('needs_review.low_confidence(label=Landlord Name,pct=55)')
      .closest('li');
    expect(lowLi?.querySelector('.text-destructive')).toBeTruthy();
    expect(lowLi?.querySelector('.text-amber-500')).toBeNull();

    const midLi = screen
      .getByText('needs_review.low_confidence(label=Tenant Name,pct=75)')
      .closest('li');
    expect(midLi?.querySelector('.text-amber-500')).toBeTruthy();
    expect(midLi?.querySelector('.text-destructive')).toBeNull();
  });
});

describe('NeedsReviewBanner — no extracted_json', () => {
  it('does NOT flag present fields as low-confidence when extracted_json is absent', () => {
    // getFieldConfidence returns null for every field, so present fields are
    // neither missing nor low-confidence -> nothing renders.
    const { container } = render(<NeedsReviewBanner {...ALL_PRESENT} />);
    expect(container.firstChild).toBeNull();
  });

  it('still surfaces missing fields even without extracted_json', () => {
    render(
      <NeedsReviewBanner
        landlordName={null}
        tenantName={null}
        leaseStart="2026-01-01"
        leaseEnd="2027-01-01"
      />,
    );
    const missing = screen.getAllByText(/needs_review\.missing/);
    expect(missing.length).toBe(2);
  });
});
