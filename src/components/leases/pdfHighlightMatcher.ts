/**
 * Pure matcher logic used by PdfViewer.tsx to locate the AI-extracted
 * source phrase inside a PDF page's text-layer items. Extracted into its
 * own module so it can be unit-tested without React or pdfjs.
 *
 * Public surface:
 *   - normalizeChar / normalizeForMatch — character-equivalence rules
 *   - expandCandidate                   — value/date/numeric variants
 *   - isMetaSummary                     — "across Paragraphs..." detection
 *   - isTooGenericValue                 — single-word filters
 *   - findHighlightSpans                — top-level: candidates → match
 */

export const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const MONTHS_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function normalizeChar(c: string): string {
  const lower = c.toLowerCase();
  if (/[\p{L}\p{N}]/u.test(lower)) return lower;
  return ' ';
}

export function normalizeForMatch(s: string): string {
  let out = '';
  for (const c of s) out += normalizeChar(c);
  return out.replace(/\s+/g, ' ').trim();
}

export function findLongestPhrase(
  haystack: string,
  target: string,
  minChars = 12
): { start: number; end: number } | null {
  if (target.length < minChars) return null;
  for (let len = target.length; len >= minChars; len -= Math.max(1, Math.floor(len / 16))) {
    for (let i = 0; i + len <= target.length; i++) {
      const sub = target.substring(i, i + len);
      const pos = haystack.indexOf(sub);
      if (pos !== -1) return { start: pos, end: pos + len };
    }
  }
  return null;
}

export function expandDateVariants(s: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return [];
  const [, y, mo, d] = m;
  const monthIdx = parseInt(mo, 10) - 1;
  const dayNum = parseInt(d, 10);
  if (monthIdx < 0 || monthIdx > 11 || dayNum < 1 || dayNum > 31) return [];
  const full = MONTHS_FULL[monthIdx];
  const abbr = MONTHS_ABBR[monthIdx];
  return [
    `${full} ${dayNum}, ${y}`,
    `${full} ${dayNum} ${y}`,
    `${abbr} ${dayNum}, ${y}`,
    `${abbr}. ${dayNum}, ${y}`,
    `${parseInt(mo, 10)}/${dayNum}/${y}`,
    `${mo}/${d}/${y}`,
    `${parseInt(mo, 10)}-${dayNum}-${y}`,
    `${dayNum} ${full} ${y}`,
  ];
}

const GENERIC_SINGLE_WORDS = new Set([
  'yes', 'no', 'true', 'false', 'na', 'n/a',
  'monthly', 'annual', 'annually', 'quarterly', 'weekly', 'daily', 'biweekly', 'bi-weekly',
  'fixed', 'variable', 'none',
  'active', 'inactive', 'pending', 'expired',
]);

export function isTooGenericValue(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!/\s/.test(t) && GENERIC_SINGLE_WORDS.has(t)) return true;
  return false;
}

export function isMetaSummary(s: string): boolean {
  if (!s) return false;
  return (
    /^multiple\b.*\bacross\s+paragraphs?\b/i.test(s) ||
    /^see\s+paragraphs?\b/i.test(s) ||
    /^n\s*\/\s*a\b/i.test(s) ||
    /^paragraphs?\s+\d/i.test(s) ||
    /\bsee\s+(paragraph|exhibit|schedule|attached)\b/i.test(s)
  );
}

export function isPurelyNumeric(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return /^[$£€]?[\d,]+(?:\.\d+)?%?$/.test(trimmed);
}

export function expandCandidate(c: string): string[] {
  const out = new Set<string>([c]);
  for (const dv of expandDateVariants(c)) out.add(dv);
  if (/^-?\d+(\.\d+)?$/.test(c.trim())) {
    const n = Number(c);
    if (Number.isFinite(n)) {
      out.add(n.toLocaleString('en-US'));
      out.add(String(Math.round(n)));
      out.add(Math.round(n).toLocaleString('en-US'));
    }
  }
  // Digits-only variant ONLY for candidates that are themselves purely
  // numeric. Otherwise, for text-with-digits values (e.g. an address),
  // we'd synthesize "392881" from "3 Latitude Way ... 92881" and Phase 1
  // would match the random "392881" any time the haystack happened to
  // contain those digits in sequence — exactly the wrong tokens.
  if (isPurelyNumeric(c)) {
    const digitsOnly = c.replace(/[^\d]/g, '');
    if (digitsOnly.length >= 3) out.add(digitsOnly);
  }
  return Array.from(out).filter((s) => s.trim().length > 0);
}

export type MatchKind = 'exact-text' | 'digits-only' | 'longest-substring' | 'not-found' | 'spans-sections' | 'no-candidates';

export interface MatchResult {
  kind: MatchKind;
  candidate?: string;
  variant?: string;
  matched?: string;
}

/**
 * Highest-level matcher used in tests. Operates on a flat haystack string
 * (the concatenated, unmodified PDF page text) — NOT pdfjs items. This is
 * sufficient to validate candidate-side logic (date conversion, paraphrase
 * fallback, meta-summary detection, etc).
 *
 * The browser-side PdfViewer wraps the same logic with per-item char maps
 * so the resulting `<mark>` tightly hugs the matched substring within
 * each pdfjs text item.
 */
export function findHighlightSpans(haystack: string, candidates: Array<string | undefined>): MatchResult {
  const cleaned = candidates.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  if (cleaned.length === 0) return { kind: 'no-candidates' };

  // Phase 0 — meta-summary short-circuit.
  if (cleaned.every((c) => isMetaSummary(c))) {
    return { kind: 'spans-sections' };
  }

  // Build normalized + digits-only haystacks.
  let combined = '';
  let lastSpace = true;
  for (const c of haystack) {
    const norm = normalizeChar(c);
    if (norm === ' ' && lastSpace) continue;
    combined += norm;
    lastSpace = norm === ' ';
  }
  combined = combined.trim();
  let combinedDigits = '';
  for (const c of haystack) if (/\d/.test(c)) combinedDigits += c;

  // Phase 1 — exact text match across all candidates and their variants,
  // skipping generic single-word values.
  for (const candidate of cleaned) {
    if (isTooGenericValue(candidate)) continue;
    for (const variant of expandCandidate(candidate)) {
      const normalized = normalizeForMatch(variant);
      if (normalized.length < 3) continue;
      const pos = combined.indexOf(normalized);
      if (pos !== -1) {
        return {
          kind: 'exact-text',
          candidate,
          variant,
          matched: combined.slice(pos, pos + normalized.length),
        };
      }
    }
  }

  // Phase 2 — digits-only haystack, only for purely-numeric candidates.
  for (const candidate of cleaned) {
    if (!isPurelyNumeric(candidate)) continue;
    const variantDigits = candidate.replace(/[^\d]/g, '');
    if (variantDigits.length < 3) continue;
    const dpos = combinedDigits.indexOf(variantDigits);
    if (dpos !== -1) {
      return { kind: 'digits-only', candidate, variant: variantDigits };
    }
  }

  // Phase 3 — longest-substring fallback on source_text (last candidate).
  const fallbackSrc = cleaned[cleaned.length - 1];
  const fallbackTarget = normalizeForMatch(fallbackSrc);
  const minFallbackLen = Math.max(20, Math.floor(fallbackTarget.length * 0.5));
  const longest = findLongestPhrase(combined, fallbackTarget, minFallbackLen);
  if (longest) {
    return {
      kind: 'longest-substring',
      candidate: fallbackSrc,
      matched: combined.slice(longest.start, longest.end),
    };
  }

  return { kind: 'not-found', candidate: cleaned[0] };
}
