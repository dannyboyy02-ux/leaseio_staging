// @vitest-environment jsdom
import '../../workspace/__tests__/_jsdomPolyfills';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Regression coverage for the B1 fix. NeedsReviewBanner was rewritten to read
// per-field confidence from the live `extracted_json` via getFieldConfidence
// (cutoff = LOW_CONFIDENCE_THRESHOLD/100 = 0.80) instead of the never-populated
// `lease.confidence_scores` column — so the low-confidence warning could never
// fire before. This pins:
//   - a present field below the cutoff is flagged with its rounded percentage,
//   - a present field at/above the cutoff is NOT flagged,
//   - a missing (falsy) field is surfaced as "is missing",
//   - all-good renders nothing (the component returns null),
//   - the 0.80 boundary: 0.80 not flagged, 0.79 flagged.
//
// Note: NeedsReviewBanner imports getFieldConfidence from the pure
// `@/lib/extractedFieldHelpers` module — NOT the supabase client. This test
// mounting cleanly (no module-resolution error pulling in supabase) is itself
// part of the contract.

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
  it('flags a present field with confidence 0.55 as "low confidence (55%)"', () => {
    render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          landlord_name: { value: 'Acme LLC', confidence: 0.55 },
        }}
      />,
    );
    expect(screen.getByText('Review Required')).toBeTruthy();
    // Rounded percentage rendered as "(55%)".
    expect(screen.getByText(/low confidence \(55%\)/i)).toBeTruthy();
    expect(screen.getByText('Landlord Name')).toBeTruthy();
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
    expect(screen.queryByText('Review Required')).toBeNull();
    expect(screen.queryByText(/low confidence/i)).toBeNull();
  });
});

describe('NeedsReviewBanner — missing fields', () => {
  it('surfaces a missing (falsy) field as "is missing"', () => {
    render(
      <NeedsReviewBanner
        landlordName={null}
        tenantName="Beta Corp"
        leaseStart="2026-01-01"
        leaseEnd="2027-01-01"
        extractedJson={HIGH_CONF_JSON}
      />,
    );
    expect(screen.getByText('Review Required')).toBeTruthy();
    expect(screen.getByText('Landlord Name')).toBeTruthy();
    expect(screen.getByText(/is missing/i)).toBeTruthy();
    // A missing field is reported as missing, never as low-confidence.
    expect(screen.queryByText(/low confidence/i)).toBeNull();
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
    // 0.80 >= cutoff -> not flagged -> no issues -> renders nothing.
    expect(container.firstChild).toBeNull();
  });

  it('flags a field just below the cutoff (0.79 -> "79%")', () => {
    render(
      <NeedsReviewBanner
        {...ALL_PRESENT}
        extractedJson={{
          ...HIGH_CONF_JSON,
          tenant_name: { value: 'Beta Corp', confidence: 0.79 },
        }}
      />,
    );
    expect(screen.getByText('Review Required')).toBeTruthy();
    expect(screen.getByText(/low confidence \(79%\)/i)).toBeTruthy();
    expect(screen.getByText('Tenant Name')).toBeTruthy();
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
    expect(screen.getByText(/low confidence \(60%\)/i)).toBeTruthy();
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
    expect(screen.getByText('Landlord Name')).toBeTruthy();
    expect(screen.getByText('Tenant Name')).toBeTruthy();
    const missing = screen.getAllByText(/is missing/i);
    expect(missing.length).toBe(2);
  });
});
