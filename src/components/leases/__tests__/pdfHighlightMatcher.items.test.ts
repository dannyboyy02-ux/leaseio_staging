/**
 * Item-level coverage of the highlight matcher. These fixtures simulate the
 * pdfjs text-content items that the BROWSER actually receives — multiple
 * items per line, occasional intra-word splits from font/style boundaries,
 * `hasEOL: true` markers at line breaks, etc.
 *
 * Each test asserts both the match kind AND the per-item char spans so we
 * know the highlight will visually hug the right tokens, not the whole line.
 *
 * If you encounter a new lease whose Sparkles highlight is off, add a fixture
 * here that reproduces the issue, then fix the matcher until the test passes.
 */

import { describe, it, expect } from 'vitest';
import {
  findHighlightSpansForItems,
  reconstructHighlight,
  findFuzzyTokenRun,
  levBounded,
} from '../pdfHighlightMatcher';

type Item = { str: string; hasEOL?: boolean };

describe('levBounded', () => {
  it('returns true for equal strings', () => {
    expect(levBounded('latitude', 'latitude', 0)).toBe(true);
  });
  it('returns true for 1-edit difference within max=1', () => {
    expect(levBounded('latitude', 'latitudd', 1)).toBe(true);
  });
  it('handles font-glyph 1-char substitution within length tolerance', () => {
    // "LaƟtude" → "laɵtude" (7 chars) vs "latitude" (8 chars): edits = 2
    // (substitute Ɵ for ti = 1 sub + 1 insert).
    expect(levBounded('laɵtude', 'latitude', 2)).toBe(true);
    expect(levBounded('laɵtude', 'latitude', 1)).toBe(false);
  });
  it('rejects when length difference exceeds max', () => {
    expect(levBounded('a', 'abcdef', 2)).toBe(false);
  });
});

describe('findFuzzyTokenRun', () => {
  it('finds a 5-token consecutive run with one fuzzy token', () => {
    const haystack = 'foo bar baz LaƟtude 36 Foods LLC qux';
    const target = 'Latitude 36 Foods LLC';
    const r = findFuzzyTokenRun(haystack, target);
    expect(r).not.toBeNull();
    expect(r!.matchedTokens).toBe(4);
  });
  it('returns null when too few tokens align', () => {
    const haystack = 'foo bar baz qux';
    const target = 'completely different sentence here';
    expect(findFuzzyTokenRun(haystack, target)).toBeNull();
  });
});

describe('findHighlightSpansForItems — pdfjs item fixtures', () => {
  it('intra-word split (font-style boundary): ["La","titude 36 Foods..."]', () => {
    const items: Item[] = [
      { str: 'La' },
      { str: 'titude 36 Foods, LLC, a Delaware limited liability company' },
    ];
    const r = findHighlightSpansForItems(items, [
      'Latitude 36 Foods, LLC, a Delaware limited liability company',
      'Latitude 36 Foods, LLC, a Delaware limited liability company ("Lessee")',
    ]);
    expect(r.kind).toBe('exact-text');
    // Spans must cover both items 0 ("La") and 1 ("titude 36 Foods...") so
    // the visual highlight in the browser hugs the whole company name.
    const itemIndices = r.spans.map((s) => s.itemIndex).sort();
    expect(itemIndices).toContain(0);
    expect(itemIndices).toContain(1);
    // Item 0 span should cover all 2 chars of "La".
    const item0Span = r.spans.find((s) => s.itemIndex === 0)!;
    expect(item0Span.charStart).toBe(0);
    expect(item0Span.charEnd).toBe(2);
    // Item 1 span should start at index 0 ("titude...") and reach to the end of "company".
    const item1Span = r.spans.find((s) => s.itemIndex === 1)!;
    expect(item1Span.charStart).toBe(0);
    expect(item1Span.charEnd).toBeGreaterThanOrEqual('titude 36 Foods, LLC, a Delaware limited liability company'.length);
    // Normalized debug-text comparison (ignores whitespace) should contain the value.
    const text = reconstructHighlight(items, r.spans);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    expect(norm(text)).toContain(norm('Latitude 36 Foods, LLC, a Delaware limited liability company'));
  });

  it('font-glyph artifact: pdfjs returns "LaƟtude" but value is "Latitude"', () => {
    const items: Item[] = [
      { str: 'LaƟtude 36 Foods, LLC, a Delaware limited liability company' },
    ];
    const r = findHighlightSpansForItems(items, [
      'Latitude 36 Foods, LLC, a Delaware limited liability company',
      'Latitude 36 Foods, LLC, a Delaware limited liability company ("Lessee")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.spans.length).toBeGreaterThan(0);
    const text = reconstructHighlight(items, r.spans);
    // Highlight should include the LaƟtude rendering — that's what's actually
    // visible to the user.
    expect(text).toContain('LaƟtude');
  });

  it('line-break boundary: hasEOL prevents word fusion across lines', () => {
    const items: Item[] = [
      // First item ends a line.
      { str: 'options to extend the lease term at the then', hasEOL: true },
      // Second item starts the next line.
      { str: 'fair-market lease rate' },
    ];
    const r = findHighlightSpansForItems(items, [
      undefined as unknown as string,
      'options to extend the lease term at the then fair-market lease rate',
    ]);
    expect(r.kind).toBe('exact-text');
    // Must touch both items.
    const itemIndices = r.spans.map((s) => s.itemIndex).sort();
    expect(itemIndices).toContain(0);
    expect(itemIndices).toContain(1);
  });

  it('regression: would have over-fused "then" + "fair" without hasEOL', () => {
    // Previous bug: ["...the then", "fair-market..."] both alphanumeric ends
    // would fuse to "thenfair" if hasEOL was ignored — breaking the match.
    const items: Item[] = [
      { str: 'extending the lease at the then', hasEOL: true },
      { str: 'fair-market lease rate' },
    ];
    const r = findHighlightSpansForItems(items, [
      undefined as unknown as string,
      'at the then fair-market lease rate',
    ]);
    expect(r.kind).toBe('exact-text');
  });

  it('property address: VALUE wins over source_text for tighter highlight', () => {
    const items: Item[] = [
      {
        str:
          'commonly known as (street address, city, state, zip): 3 Latitude Way, Corona, CA, 92881 ("Premises")',
      },
    ];
    const r = findHighlightSpansForItems(items, [
      '3 Latitude Way, Corona, CA 92881',
      'commonly known as (street address, city, state, zip): 3 Latitude Way, Corona, CA, 92881 ("Premises")',
    ]);
    expect(r.kind).toBe('exact-text');
    const text = reconstructHighlight(items, r.spans);
    // Should contain the address but NOT the surrounding "commonly known as" prelude.
    expect(text.toLowerCase()).toContain('3 latitude way, corona, ca');
    expect(text.toLowerCase()).not.toContain('commonly known');
  });

  it('numeric value with comma in PDF: 44833 → highlights "44,833"', () => {
    const items: Item[] = [
      { str: 'consisting of approximately 44,833 square feet as determined by HPA' },
    ];
    const r = findHighlightSpansForItems(items, [
      '44833',
      'a freestanding industrial building ("Building") consisting of approximately 44,833 square feet as determined by HPA Architecture',
    ]);
    expect(r.kind).toBe('exact-text');
    const text = reconstructHighlight(items, r.spans);
    expect(text).toContain('44,833');
    expect(text).not.toContain('square feet'); // tighter than source_text
  });

  it('currency value across pdfjs item split: ["$","69,491.15"," per month"]', () => {
    const items: Item[] = [
      { str: '$' },
      { str: '69,491.15' },
      { str: ' per month' },
    ];
    const r = findHighlightSpansForItems(items, [
      '69491.15',
      '$69,491.15 per month ("Base Rent")',
    ]);
    expect(r.kind).toBe('exact-text');
    const text = reconstructHighlight(items, r.spans);
    expect(text).toContain('69,491.15');
  });

  it('ISO date "2023-03-01" → matches "March 1, 2023" in PDF text', () => {
    const items: Item[] = [
      { str: 'Original Term: Nine (9) years and Three (3) months commencing March 1, 2023 ("Commencement Date")' },
    ];
    const r = findHighlightSpansForItems(items, [
      '2023-03-01',
      'commencing March 1, 2023 ("Commencement Date")',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.variant).toBe('March 1, 2023');
  });

  it('meta-summary source_text: returns spans-sections without spurious highlight', () => {
    const items: Item[] = [
      { str: 'Termination Section 9. Various provisions on damage, condemnation, and breach.' },
    ];
    const r = findHighlightSpansForItems(items, [
      undefined as unknown as string,
      'Multiple termination provisions across Paragraphs 2.3, 3.3, 6.2(g), 9.3, 9.4, 9.5, and 14',
    ]);
    expect(r.kind).toBe('spans-sections');
    expect(r.spans.length).toBe(0);
  });

  it('See-Paragraph meta-summary: returns spans-sections', () => {
    const items: Item[] = [
      { str: 'Some unrelated content on the page' },
    ];
    const r = findHighlightSpansForItems(items, [
      undefined as unknown as string,
      'See Paragraph 52 rent schedule and Paragraph 57 Options to Extend',
    ]);
    expect(r.kind).toBe('spans-sections');
  });

  it('regression: address with digits does NOT fall through to digit-only path', () => {
    // The address synthesizes "392881" if expandCandidate is run on it. The
    // matcher must NOT match "392881" anywhere in the haystack just because
    // the address contained those digits.
    const items: Item[] = [
      // Haystack with "3" near the start and "92881" further along.
      { str: 'Section 3 of this Agreement. Premises are located at 100 Main St, Corona, CA, 92881 (the "Premises").' },
    ];
    const r = findHighlightSpansForItems(items, ['3 Latitude Way, Corona, CA 92881']);
    // Should NOT match — the address's actual tokens "Latitude" and "Way" are absent.
    expect(r.kind).toBe('not-found');
  });

  it('long quote spanning multiple line-broken items: token-fuzzy still finds it', () => {
    // Realistic line-wrapped lease text — many short items, all from same paragraph.
    const items: Item[] = [
      { str: 'Subject to the provisions of Paragraph 39 and Exhibit E, Lessee', hasEOL: true },
      { str: 'shall have two (2) five (5) year options to extend the lease term', hasEOL: true },
      { str: '(each an "Option") at the then fair-market lease rate at the time', hasEOL: true },
      { str: 'an Option is exercised; however, the starting Base Rent for any', hasEOL: true },
      { str: 'Option(s) term(s), if and when exercised, shall not be less than', hasEOL: true },
      { str: 'the previous Base Rent prior to the start of any Option term.' },
    ];
    const r = findHighlightSpansForItems(items, [
      undefined as unknown as string,
      'Lessee shall have two (2) five (5) year options to extend the lease term (each an "Option") at the then fair-market lease rate at the time an Option is exercised; however, the starting Base Rent for any Option(s) term(s), if and when exercised, shall not be less than the previous Base Rent prior to the start of any Option term.',
    ]);
    expect(r.kind).toBe('exact-text');
    // Should span all 6 items (the full quote is line-wrapped across them).
    const itemIndices = new Set(r.spans.map((s) => s.itemIndex));
    expect(itemIndices.size).toBeGreaterThanOrEqual(5);
  });

  it('per-item char spans — only matched chars are wrapped, not whole items', () => {
    const items: Item[] = [
      { str: 'Lessor: Five Degrees, LLC, a California limited liability company. Other text follows here.' },
    ];
    const r = findHighlightSpansForItems(items, [
      'Five Degrees, LLC, a California limited liability company',
    ]);
    expect(r.kind).toBe('exact-text');
    expect(r.spans).toHaveLength(1);
    const span = r.spans[0];
    // Match starts at "Five" (after "Lessor: "), should be charStart > 0
    expect(span.charStart).toBeGreaterThan(0);
    // And ends before "Other text follows..." at less than full string length.
    expect(span.charEnd).toBeLessThan(items[0].str.length);
    const text = reconstructHighlight(items, r.spans);
    expect(text).toContain('Five Degrees');
    expect(text).not.toContain('Other text');
    expect(text).not.toContain('Lessor:');
  });

  it('graceful: empty items array → not-found', () => {
    const r = findHighlightSpansForItems([], ['target']);
    expect(r.kind).toBe('not-found');
  });

  it('graceful: empty candidates → no-candidates', () => {
    const r = findHighlightSpansForItems([{ str: 'something' }], []);
    expect(r.kind).toBe('no-candidates');
  });

  it('AIR CRE ligature glyphs (Ɵ Ʃ Ō ﬁ): "addiƟonal" / "wriƩen" / "iniƟal" still match', () => {
    // Real page-3 text from the test lease: PDF font CMap encodes "ti", "tt",
    // "ft", "fi" ligatures as single Unicode codepoints. Without the glyph map
    // the fuzzy matcher's small per-token edit budget can't bridge the gap on
    // short tokens like "Ɵmes" → "times".
    const items: Item[] = [
      {
        str:
          'during the term of this Lease, Lessee shall, upon wriƩen request from Lessor, deposit addiƟonal monies with Lessor so that the total amount of the Security Deposit shall at all Ɵmes bear the same proporƟon to the increased Base Rent as the iniƟal Security Deposit bore to the iniƟal Base Rent.',
      },
    ];
    const citation =
      'If the Base Rent increases during the term of this Lease, Lessee shall, upon written request from Lessor, deposit additional monies with Lessor so that the total amount of the Security Deposit shall at all times bear the same proportion to the increased Base Rent as the initial Security Deposit bore to the initial Base Rent.';
    const r = findHighlightSpansForItems(items, [undefined as unknown as string, citation]);
    expect(r.kind).toBe('exact-text');
    expect(r.spans.length).toBeGreaterThan(0);
    const text = reconstructHighlight(items, r.spans);
    // Highlight should cover the bulk of the citation text actually present
    // on the page (the "If the Base Rent increases" prefix lives on page 2).
    expect(text).toContain('Security Deposit');
    expect(text).toContain('Base Rent');
  });
});
