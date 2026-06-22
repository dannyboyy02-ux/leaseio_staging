import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIELD_MAX,
  NAME_MAX,
  MAX_RISKS,
  truncate,
  summarizeRisks,
} from '../../../supabase/functions/_shared/ai_context';

// Audit F1 — the ai-assistant context packet bounds every variable-length field
// pulled from extracted_json so a verbose portfolio can't balloon the prompt.
// The bounding helpers are pure + dependency-free precisely so they can be
// unit-tested here even though the edge function runs on Deno.

describe('ai-assistant context bounding — truncate', () => {
  it('returns null for nullish / empty / whitespace input', () => {
    expect(truncate(null, FIELD_MAX)).toBeNull();
    expect(truncate(undefined, FIELD_MAX)).toBeNull();
    expect(truncate('', FIELD_MAX)).toBeNull();
    expect(truncate('   ', FIELD_MAX)).toBeNull();
  });

  it('passes short strings through unchanged (trimmed)', () => {
    expect(truncate('Net lease', FIELD_MAX)).toBe('Net lease');
    expect(truncate('  padded  ', FIELD_MAX)).toBe('padded');
  });

  it('truncates an over-length string with an ellipsis and never exceeds max+1', () => {
    const long = 'x'.repeat(FIELD_MAX + 500);
    const out = truncate(long, FIELD_MAX)!;
    expect(out.endsWith('…')).toBe(true);
    // sliced to FIELD_MAX chars + the single ellipsis glyph
    expect(out.length).toBeLessThanOrEqual(FIELD_MAX + 1);
    expect(out.startsWith('xxxx')).toBe(true);
  });

  it('coerces non-string values (object / number) rather than emitting [object Object] unbounded', () => {
    expect(truncate(42, FIELD_MAX)).toBe('42');
    const big = truncate({ a: 'b'.repeat(FIELD_MAX + 50) }, FIELD_MAX)!;
    expect(big.length).toBeLessThanOrEqual(FIELD_MAX + 1);
  });

  it('respects a smaller NAME_MAX bound for short identifiers', () => {
    const out = truncate('y'.repeat(NAME_MAX + 50), NAME_MAX)!;
    expect(out.length).toBeLessThanOrEqual(NAME_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('passes a string of exactly max length through unchanged (no ellipsis)', () => {
    const exact = 'x'.repeat(FIELD_MAX);
    const out = truncate(exact, FIELD_MAX)!;
    expect(out).toBe(exact);
    expect(out.length).toBe(FIELD_MAX);
    expect(out.endsWith('…')).toBe(false);
  });

  it('truncates a string of exactly max+1 length (the off-by-one boundary)', () => {
    const out = truncate('x'.repeat(FIELD_MAX + 1), FIELD_MAX)!;
    expect(out.endsWith('…')).toBe(true);
    // sliced back to FIELD_MAX content chars + the ellipsis glyph
    expect(out.length).toBe(FIELD_MAX + 1);
  });

  it('uses a single-char ellipsis glyph so the length math holds', () => {
    // The whole suite's "≤ max+1" bound depends on "…" being one JS code unit,
    // not the three-char "...". Pin it so a "fix" to ASCII dots is caught.
    const out = truncate('x'.repeat(FIELD_MAX + 10), FIELD_MAX)!;
    expect(out.length).toBe(FIELD_MAX + 1);
    expect(out.slice(-1)).toBe('…');
    expect(out.slice(-3)).not.toBe('...');
  });

  it('trims trailing whitespace before the ellipsis when the cut lands on a space', () => {
    // 5 content chars, then spaces, then more content. Cutting at max=8 slices
    // "aaaaa   " → trimEnd → "aaaaa", so the result is SHORTER than max+1 and
    // has no dangling space wedged against the ellipsis.
    const value = `${'a'.repeat(5)}     ${'b'.repeat(20)}`;
    const out = truncate(value, 8)!;
    expect(out).toBe('aaaaa…');
    expect(out).not.toContain(' …');
    expect(out.length).toBeLessThan(8 + 1);
  });
});

describe('ai-assistant context bounding — summarizeRisks', () => {
  it('returns null when there are no risks (or a non-array)', () => {
    expect(summarizeRisks([])).toBeNull();
    expect(summarizeRisks(undefined)).toBeNull();
    expect(summarizeRisks('nope')).toBeNull();
  });

  it('formats each risk as "SEVERITY - title"', () => {
    const out = summarizeRisks([
      { severity: 'high', title: 'Personal guarantee' },
      { severity: 'low', title: 'Auto-renewal' },
    ]);
    expect(out).toBe('HIGH - Personal guarantee; LOW - Auto-renewal');
  });

  it('caps the list at MAX_RISKS and appends a "+N more" tail', () => {
    const many = Array.from({ length: MAX_RISKS + 5 }, (_, i) => ({
      severity: 'med',
      title: `Risk ${i}`,
    }));
    const out = summarizeRisks(many)!;
    expect(out).toContain('+5 more');
    // exactly MAX_RISKS rendered entries before the tail
    expect(out.split('; ').filter((s) => s.startsWith('MED - ')).length).toBe(MAX_RISKS);
  });

  it('tolerates a missing severity / title without throwing', () => {
    expect(summarizeRisks([{ title: 'Untyped' }])).toBe('RISK - Untyped');
    expect(summarizeRisks([{ severity: 'high' }])).toBe('HIGH - untitled');
  });

  it('bounds an over-length risk title', () => {
    const out = summarizeRisks([{ severity: 'high', title: 'z'.repeat(NAME_MAX + 100) }])!;
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual('HIGH - '.length + NAME_MAX + 1);
  });

  it('renders exactly MAX_RISKS entries with NO "+N more" tail at the boundary', () => {
    const exactly = Array.from({ length: MAX_RISKS }, (_, i) => ({
      severity: 'med',
      title: `Risk ${i}`,
    }));
    const out = summarizeRisks(exactly)!;
    expect(out).not.toContain('more');
    expect(out.split('; ').length).toBe(MAX_RISKS);
    expect(out.split('; ').every((s) => s.startsWith('MED - '))).toBe(true);
  });

  it('renders "+1 more" at the first over-cap entry (MAX_RISKS + 1)', () => {
    const oneOver = Array.from({ length: MAX_RISKS + 1 }, (_, i) => ({
      severity: 'med',
      title: `Risk ${i}`,
    }));
    expect(summarizeRisks(oneOver)).toContain('+1 more');
  });

  it('keeps HIGH-severity risks through the cap even when LOW risks come first (audit F1 HIGH)', () => {
    // MAX_RISKS low risks followed by one high risk past the cap. A naive
    // array-order slice would drop the high; severity-sort must surface it.
    const risks = [
      ...Array.from({ length: MAX_RISKS }, (_, i) => ({ severity: 'low', title: `Low ${i}` })),
      { severity: 'high', title: 'Personal guarantee' },
    ];
    const out = summarizeRisks(risks)!;
    expect(out).toContain('HIGH - Personal guarantee');
    expect(out).toContain('+1 more'); // one low risk got dropped, not the high
    // the high risk is surfaced first (highest severity rank)
    expect(out.startsWith('HIGH - Personal guarantee')).toBe(true);
  });

  it('orders by severity (high → medium → low) and treats critical as top rank', () => {
    const out = summarizeRisks([
      { severity: 'low', title: 'L' },
      { severity: 'critical', title: 'C' },
      { severity: 'medium', title: 'M' },
      { severity: 'high', title: 'H' },
    ])!;
    // critical and high share rank 0 (stable order keeps C before H); then M, then L
    expect(out).toBe('CRITICAL - C; HIGH - H; MEDIUM - M; LOW - L');
  });

  it('fails SAFE: a present-but-off-vocabulary severity survives the cap (not dropped first)', () => {
    // extracted_json.risks is the raw model blob (not CHECK-constrained); the
    // extraction prompt itself models "MEDIUM-HIGH". An unrecognized non-empty
    // severity must surface (rank 0), not sort last and get dropped.
    const risks = [
      ...Array.from({ length: MAX_RISKS }, (_, i) => ({ severity: 'low', title: `Low ${i}` })),
      { severity: 'MEDIUM-HIGH', title: 'Spelled-off but serious' },
    ];
    const out = summarizeRisks(risks)!;
    expect(out).toContain('MEDIUM-HIGH - Spelled-off but serious');
    expect(out.startsWith('MEDIUM-HIGH - Spelled-off but serious')).toBe(true);
    expect(out).toContain('+1 more'); // a LOW got dropped, not the off-vocabulary risk
  });

  it('coerces a non-string severity sensibly (number reads, object degrades predictably)', () => {
    // A numeric severity reads fine; an object severity degrades to the JS
    // String() form — pinned so a future "objects should fall back to RISK"
    // decision is a deliberate test change, not silent drift.
    expect(summarizeRisks([{ severity: 2, title: 'Numeric sev' }])).toBe('2 - Numeric sev');
    expect(summarizeRisks([{ severity: {}, title: 'Object sev' }])).toBe(
      '[OBJECT OBJECT] - Object sev',
    );
  });

  it('falls back to "RISK" for a falsy-but-present severity (0 / empty string)', () => {
    // Distinct code path from a missing key: `r?.severity ? ... : 'RISK'` is
    // falsy-guarded, so severity 0 or "" also collapses to RISK.
    expect(summarizeRisks([{ severity: 0, title: 'Zero sev' }])).toBe('RISK - Zero sev');
    expect(summarizeRisks([{ severity: '', title: 'Empty sev' }])).toBe('RISK - Empty sev');
  });
});

// Static pin: the edge function must actually apply the bounding helpers to every
// variable-length field (the unit tests above only prove the helpers work).
describe('ai-assistant/index.ts applies the bounding helpers (audit F1)', () => {
  const src = readFileSync(
    join(process.cwd(), 'supabase/functions/ai-assistant/index.ts'),
    'utf8',
  );

  it('imports the bounding helpers from the shared module', () => {
    expect(src).toContain('from "../_shared/ai_context.ts"');
    expect(src).toContain('truncate');
    expect(src).toContain('summarizeRisks');
  });

  it('bounds each free-text clause field with truncate(..., FIELD_MAX)', () => {
    for (const field of ['security_deposit', 'renewal_options', 'termination_clauses', 'escalation_clauses']) {
      expect(src, `${field} should be bounded`).toContain(`extractValue(json.${field})`);
    }
    expect(src).toContain('FIELD_MAX');
    expect(src).toContain('NAME_MAX');
  });

  it('summarizes risks instead of mapping the unbounded array inline', () => {
    expect(src).toContain('summarizeRisks(json?.risks)');
    // the old unbounded inline map must be gone
    expect(src).not.toContain('risks.map((r: any)');
  });
});
