/**
 * End-to-end coverage of every category of AI-extracted field that the
 * Sparkles → highlight feature needs to handle. Each test simulates a
 * realistic snippet of PDF page text and asserts the matcher locates the
 * abstracted value with the expected match kind.
 *
 * Failure here means clicking the Sparkles for that field type would NOT
 * highlight correctly in the actual app.
 */

import { describe, it, expect } from 'vitest';
import {
  findHighlightSpans,
  expandDateVariants,
  expandEllipsisSegments,
  isMetaSummary,
  isTooGenericValue,
  isPurelyNumeric,
  expandCandidate,
} from '../pdfHighlightMatcher';

// Realistic PDF page text excerpts — concatenated approximations of what
// pdfjs would return from a typical commercial-real-estate lease.
const PDF_PAGE_1 = `
BASIC LEASE INFORMATION

Lessor: Five Degrees, LLC, a California limited liability company ("Lessor")
Lessee: Latitude 36 Foods, LLC, a Delaware limited liability company ("Lessee")

Premises: a freestanding industrial building ("Building") consisting of
approximately 44,833 square feet as determined by HPA Architecture, commonly
known as (street address, city, state, zip): 3 Latitude Way, Corona, CA, 92881
("Premises").

Original Term: Nine (9) years and Three (3) months ("Original Term") commencing
March 1, 2023 ("Commencement Date") and ending May 31, 2032 ("Expiration Date").

Base Rent: $69,491.15 per month ("Base Rent"), payable on the first day of each
month commencing March 1, 2023.

Security Deposit: $100,000.00 ("Security Deposit").
`;

const PDF_PAGE_14 = `
the starting Base Rent for any Option(s) term(s), if and when exercised, shall
not be less than the previous Base Rent prior to the start of any Option term.
Thereafter, the Base Rent shall be increased by the then current market increase,
but in no event less than three and one-half (3.5%) percent.
`;

const PDF_PAGE_16 = `
Lessee shall have two (2) five (5) year options to extend the lease term (each
an "Option") at the then fair-market lease rate at the time an Option is
exercised; however, the starting Base Rent for any Option(s) term(s), if and
when exercised, shall not be less than the previous Base Rent prior to the
start of any Option term.
`;

describe('expandDateVariants', () => {
  it('produces multiple textual forms for an ISO date', () => {
    const variants = expandDateVariants('2023-03-01');
    expect(variants).toContain('March 1, 2023');
    expect(variants).toContain('Mar 1, 2023');
    expect(variants).toContain('3/1/2023');
    expect(variants).toContain('1 March 2023');
  });
  it('returns [] for non-ISO strings', () => {
    expect(expandDateVariants('not-a-date')).toEqual([]);
    expect(expandDateVariants('March 1, 2023')).toEqual([]);
  });
});

describe('isMetaSummary', () => {
  it('flags "Multiple ... across Paragraphs ..."', () => {
    expect(isMetaSummary('Multiple termination provisions across Paragraphs 2.3, 3.3, 6.2(g)')).toBe(true);
  });
  it('flags "See Paragraph N"', () => {
    expect(isMetaSummary('See Paragraph 52 rent schedule and Paragraph 57 Options to Extend')).toBe(true);
  });
  it('does not flag actual lease language', () => {
    expect(isMetaSummary('commencing March 1, 2023 ("Commencement Date")')).toBe(false);
    expect(isMetaSummary('Five Degrees, LLC')).toBe(false);
  });
});

describe('isTooGenericValue', () => {
  it('flags single common labels', () => {
    expect(isTooGenericValue('monthly')).toBe(true);
    expect(isTooGenericValue('Yes')).toBe(true);
    expect(isTooGenericValue('annually')).toBe(true);
  });
  it('does not flag multi-word values or specific terms', () => {
    expect(isTooGenericValue('Five Degrees, LLC')).toBe(false);
    expect(isTooGenericValue('44,833')).toBe(false);
  });
});

describe('isPurelyNumeric', () => {
  it.each(['44833', '69,491.15', '$100,000.00', '3.5%', '£500', '€1,200'])(
    'accepts %s',
    (s) => expect(isPurelyNumeric(s)).toBe(true)
  );
  it.each(['3 Latitude Way', 'Five Degrees, LLC', 'monthly'])(
    'rejects %s',
    (s) => expect(isPurelyNumeric(s)).toBe(false)
  );
});

describe('expandCandidate — number variants', () => {
  it('adds comma-grouping for plain integers', () => {
    expect(expandCandidate('44833')).toContain('44,833');
  });
  it('adds digit-only for currency-formatted strings', () => {
    expect(expandCandidate('$69,491.15')).toContain('6949115');
  });
});

// ============================================================
// THE BIG ONE — full per-field coverage
// ============================================================

describe('findHighlightSpans — every abstracted field category', () => {
  it('text value: landlord_name → exact text, hugs the company name', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      'Five Degrees, LLC, a California limited liability company',
      'Five Degrees, LLC, a California limited liability company ("Lessor")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.matched).toBe('five degrees llc a california limited liability company');
  });

  it('text value: tenant_name → exact text', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      'Latitude 36 Foods, LLC, a Delaware limited liability company',
      'Latitude 36 Foods, LLC, a Delaware limited liability company ("Lessee")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.matched).toBe('latitude 36 foods llc a delaware limited liability company');
  });

  it('text-with-digits value: property_address → exact text, full address only', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      '3 Latitude Way, Corona, CA 92881',
      'commonly known as (street address, city, state, zip): 3 Latitude Way, Corona, CA, 92881 ("Premises")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.matched).toContain('3 latitude way corona ca 92881');
    // Critical: we should NOT have fallen through to the digits-only path
    // (which would highlight "392881" — just the street # and zip).
    expect(r.kind).not.toBe('digits-only');
  });

  it('ISO date: lease_start "2023-03-01" → exact text via "March 1, 2023" variant', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      '2023-03-01',
      'commencing March 1, 2023 ("Commencement Date")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.variant).toBe('March 1, 2023');
    expect(r.matched).toBe('march 1 2023');
  });

  it('ISO date: lease_end "2032-05-31" → exact text via "May 31, 2032" variant', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      '2032-05-31',
      'ending May 31, 2032 ("Expiration Date")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.variant).toBe('May 31, 2032');
    expect(r.matched).toBe('may 31 2032');
  });

  it('numeric value: square_footage 44833 → exact text via "44,833" variant', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      '44833',
      'a freestanding industrial building ("Building") consisting of approximately 44,833 square feet',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.variant).toBe('44,833');
    expect(r.matched).toBe('44 833');
  });

  it('numeric currency: base_rent_amount "69491.15" → exact text via "69,491.15"', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      '69491.15',
      '$69,491.15 per month ("Base Rent")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.variant).toBe('69,491.15');
    expect(r.matched).toBe('69 491 15');
  });

  it('numeric: security_deposit "100000.00" → exact text via "100,000"', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      '100000.00',
      'Security Deposit: $100,000.00 ("Security Deposit")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.matched).toBe('100 000');
  });

  it('generic single word: base_rent_frequency "monthly" → SKIPS value, uses source_text', () => {
    const r = findHighlightSpans(PDF_PAGE_1, [
      'monthly',
      '$69,491.15 per month ("Base Rent"), payable on the first day of each month',
    ]);
    expect(r.kind).toBe('exact-text');
    // Should match via source_text, not via the lone "monthly" word.
    expect(r.candidate).toBe('$69,491.15 per month ("Base Rent"), payable on the first day of each month');
  });

  it('long paraphrase: renewal_options → matches via source_text', () => {
    const value = 'Two (2) five (5) year options to extend at then fair-market lease rate (not less than prior Base Rent), with subsequent annual increases at market rate but not less than 3.5%.';
    const sourceText = 'Lessee shall have two (2) five (5) year options to extend the lease term (each an "Option") at the then fair-market lease rate at the time an Option is exercised';
    const r = findHighlightSpans(PDF_PAGE_16, [value, sourceText]);
    expect(r.kind).toBe('exact-text');
    expect(r.candidate).toBe(sourceText);
  });

  it('meta-summary source_text: termination_clauses → spans-sections, no highlight', () => {
    const value = 'No general early termination or break clause for Lessee. Lease may be terminated under limited circumstances.';
    const sourceText = 'Multiple termination provisions across Paragraphs 2.3, 3.3, 6.2(g), 9.3, 9.4, 9.5, and 14';
    // The value (a paraphrase) WON'T appear verbatim in the PDF page either.
    // Both candidates fail to match — but the source_text is a meta-summary
    // we should detect and signal "spans-sections".
    const fakePageText = 'Some unrelated lease boilerplate that does not contain any of the value text.';
    // When ALL candidates are meta-summary OR fail to match, ensure we don't
    // emit a wrong highlight. A pure value+source mix where source is meta:
    const r2 = findHighlightSpans(fakePageText, [undefined as any, sourceText]);
    expect(r2.kind).toBe('spans-sections');
  });

  it('rent_escalation_type "See Paragraph 52..." → spans-sections', () => {
    const r = findHighlightSpans('Some unrelated text', [
      undefined as any,
      'See Paragraph 52 rent schedule and Paragraph 57 Options to Extend',
    ]);
    expect(r.kind).toBe('spans-sections');
  });

  it('regression: digits-only path does NOT trigger for text-with-digits values', () => {
    // For "3 Latitude Way, Corona, CA 92881" with digitsOnly = "392881",
    // if exact text fails the matcher must NOT fall through to digit-only
    // matching (which would just highlight the street number and zip).
    const fakeText = 'There is also a reference to 392881 elsewhere on this page.';
    const r = findHighlightSpans(fakeText, ['3 Latitude Way, Corona, CA 92881']);
    // No exact match; digit-only path skipped because candidate is text;
    // longest-substring requires source_text fallback (none provided).
    expect(r.kind).toBe('not-found');
  });

  it('correctness: numeric digit-only fallback only fires for purely-numeric values', () => {
    // "44833" alone in the value, PDF only has it as "44,833".
    const pdfText = 'consisting of approximately 44,833 square feet as determined by HPA';
    const r = findHighlightSpans(pdfText, ['44833']);
    // Phase 1 (exact text via "44,833" variant) succeeds.
    expect(r.kind).toBe('exact-text');
    expect(r.variant).toBe('44,833');
  });

  it('graceful: fully unmatched value+source → not-found', () => {
    const r = findHighlightSpans('completely unrelated content', [
      'something specific',
      'another phrase that is not present anywhere',
    ]);
    expect(r.kind).toBe('not-found');
  });
});

// ============================================================
// Risks (citation_snippet) — separate render path in RisksSection.
// Common shape: AI quotes a discontinuous fragment using "..." to
// signal omitted middle text. Matcher must split at ellipsis and try
// each fragment as a verbatim target.
// ============================================================

describe('expandEllipsisSegments', () => {
  it('splits at "..." and returns fragments by length desc', () => {
    const segs = expandEllipsisSegments(
      'Lessee shall not voluntarily or by operation of law assign, transfer... or sublet all or any part of Lessee\'s interest in this Lease'
    );
    expect(segs).toHaveLength(2);
    // Sorted descending — longer fragment first.
    expect(segs[0].length).toBeGreaterThanOrEqual(segs[1].length);
    expect(segs.find((s) => s.includes('Lessee shall not voluntarily'))).toBeDefined();
    expect(segs.find((s) => s.includes('sublet all or any part'))).toBeDefined();
  });
  it('handles unicode ellipsis "…"', () => {
    const segs = expandEllipsisSegments('First fragment of text…second fragment of text');
    expect(segs).toHaveLength(2);
  });
  it('returns [] when no ellipsis present', () => {
    expect(expandEllipsisSegments('A normal sentence with no ellipsis.')).toEqual([]);
  });
  it('drops fragments shorter than 12 chars', () => {
    const segs = expandEllipsisSegments('long enough fragment here ... short ... another long enough one here');
    expect(segs.every((s) => s.length >= 12)).toBe(true);
    expect(segs).not.toContain('short');
  });
});

describe('findHighlightSpans — Risks (citation_snippet) cases', () => {
  // Page 7 of the test lease: full assignment-restriction paragraph
  const PDF_PAGE_7_ASSIGN = `
    25.1 Lessor's Consent Required. Lessee shall not voluntarily or by operation
    of law assign, transfer, mortgage or encumber (collectively, "assign or
    assignment") or sublet all or any part of Lessee's interest in this Lease
    or in the Premises without Lessor's prior written consent.
  `;

  it('citation_snippet with "..." → matches the longest verbatim fragment', () => {
    const snippet =
      'Lessee shall not voluntarily or by operation of law assign, transfer, mortgage or encumber... or sublet all or any part of Lessee\'s interest in this Lease or in the Premises without Lessor\'s prior written consent.';
    const r = findHighlightSpans(PDF_PAGE_7_ASSIGN, [undefined as any, snippet]);
    expect(r.kind).toBe('exact-text');
    // The longer fragment (the second one in this case) should be what wins.
    expect(r.matched).toContain('sublet all or any part');
  });

  it('citation_snippet that is verbatim → exact text', () => {
    const PDF_PAGE_10 =
      'In the event that Lessee holds over, then the Base Rent shall be increased to 150% of the Base Rent applicable immediately preceding the expiration or termination.';
    const snippet =
      'In the event that Lessee holds over, then the Base Rent shall be increased to 150% of the Base Rent applicable immediately preceding the expiration or termination.';
    const r = findHighlightSpans(PDF_PAGE_10, [undefined as any, snippet]);
    expect(r.kind).toBe('exact-text');
  });

  it('citation_snippet that contains lease term language → exact text', () => {
    const PDF_PAGE_1 =
      'Original Term: Nine (9) years and Three (3) months ("Original Term") commencing March 1, 2023 ("Commencement Date") and ending May 31, 2032 ("Expiration Date").';
    const snippet =
      'Nine (9) years and Three (3) months ("Original Term") commencing March 1, 2023 ("Commencement Date") and ending May 31, 2032 ("Expiration Date")';
    const r = findHighlightSpans(PDF_PAGE_1, [undefined as any, snippet]);
    expect(r.kind).toBe('exact-text');
  });

  it('citation_snippet "N/A - no force majeure clause found in document" → spans-sections', () => {
    const r = findHighlightSpans('Some unrelated content', [
      undefined as any,
      'N/A - no force majeure clause found in document',
    ]);
    expect(r.kind).toBe('spans-sections');
  });

  it('citation_snippet "Net lease" verbatim quote → exact text', () => {
    const PDF_PAGE_14 =
      'This Lease is a "Net" lease and, except as expressly provided to the contrary in this Lease, Lessee is responsible for paying all amounts due in connection with use of the Premises.';
    const snippet =
      'This Lease is a "Net" lease and, except as expressly provided to the contrary in this Lease, Lessee is responsible for paying all amounts due in connection with use of the Premises.';
    const r = findHighlightSpans(PDF_PAGE_14, [undefined as any, snippet]);
    expect(r.kind).toBe('exact-text');
  });
});
