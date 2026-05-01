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

/**
 * Single-codepoint Unicode glyphs that PDF text layers (esp. AIR CRE
 * lease templates) emit instead of multi-char ligatures. Each maps to a
 * single ASCII proxy char — lossy on purpose, so the per-char origin map
 * stays 1:1 and fuzzy matching can bridge the missing letter with one
 * insert/delete instead of failing outright.
 *
 * Examples in real lease text:
 *   "wriƩen"     (Ʃ) → "writen"   (target "written"   — Lev 1, matches)
 *   "addiƟonal"  (Ɵ) → "addtonal" (target "additional"— Lev 2, matches)
 *   "Ɵmes"       (Ɵ) → "tmes"     (target "times"     — Lev 1, matches)
 *   "iniƟal"     (Ɵ) → "intal"    (target "initial"   — Lev 2, matches)
 *   "aŌer"       (Ō) → "afer"     (target "after"     — Lev 1, matches)
 */
const PDF_LIGATURE_GLYPHS: Record<string, string> = {
  'Ɵ': 't', 'ɵ': 't', // Ɵ ɵ — used for "ti" ligature
  'Ʃ': 't', 'ʃ': 't', // Ʃ ʃ — used for "tt" ligature
  'Ō': 'f', 'ō': 'f', // Ō ō — used for "ft" ligature
  'ﬀ': 'f', 'ﬁ': 'f', 'ﬂ': 'f', 'ﬃ': 'f', 'ﬄ': 'f', // ﬀ ﬁ ﬂ ﬃ ﬄ
  'ﬅ': 's', 'ﬆ': 's', // ﬅ ﬆ — st ligatures
};

export function normalizeChar(c: string): string {
  if (c in PDF_LIGATURE_GLYPHS) return PDF_LIGATURE_GLYPHS[c];
  const lower = c.toLowerCase();
  if (lower in PDF_LIGATURE_GLYPHS) return PDF_LIGATURE_GLYPHS[lower];
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

/**
 * Bounded Levenshtein — returns true if edit distance(a, b) ≤ max.
 * Early-exits as soon as the row minimum exceeds max, so common-case
 * mismatches are O(min(|a|,|b|)).
 */
export function levBounded(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;
  if (max === 0) return false;
  if (b.length === 0) return a.length <= max;
  if (a.length === 0) return b.length <= max;
  const n = a.length, m = b.length;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j - 1], dp[j]);
      prev = tmp;
      if (dp[j] < rowMin) rowMin = dp[j];
    }
    if (rowMin > max) return false;
  }
  return dp[m] <= max;
}

interface Token {
  str: string;
  start: number;
  end: number;
}

function tokenizeWithPositions(s: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ str: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Find the longest consecutive run of fuzzy-aligned tokens between
 * haystack and target. Each token may differ from its target by up to
 * ⌊len/4⌋ edits (handles font-glyph errors like "LaƟtude" vs "Latitude").
 * Requires at least half the target tokens to match for a result.
 *
 * Returns char-range in haystack covering the matched run, or null.
 */
export function findFuzzyTokenRun(haystack: string, target: string): { start: number; end: number; matchedTokens: number } | null {
  const hTokens = tokenizeWithPositions(haystack);
  const tTokens = tokenizeWithPositions(target);
  if (tTokens.length < 2 || hTokens.length === 0) return null;

  let best: { start: number; end: number; count: number } | null = null;

  // For each pair of starting positions, count consecutive aligned matches.
  for (let hStart = 0; hStart < hTokens.length; hStart++) {
    for (let tStart = 0; tStart < tTokens.length; tStart++) {
      let h = hStart, t = tStart;
      let runStart = -1, runEnd = -1, count = 0;
      while (h < hTokens.length && t < tTokens.length) {
        const ht = hTokens[h];
        const tt = tTokens[t];
        const maxDist = Math.max(1, Math.floor(tt.str.length / 4));
        if (levBounded(ht.str, tt.str, maxDist)) {
          if (runStart === -1) runStart = ht.start;
          runEnd = ht.end;
          count++;
          h++;
          t++;
        } else {
          break;
        }
      }
      if (count > 0 && (!best || count > best.count)) {
        best = { start: runStart, end: runEnd, count };
      }
    }
  }

  // Require a meaningful proportion of the target to be covered. 60% with
  // ceil() and a floor of 4 absolute tokens handles AI source quotes with
  // interjections (e.g. "(collectively, 'assign or assignment')" inside a
  // long quote — fuzzy gets ~21/32 tokens consecutive) while still rejecting
  // coincidental partial matches (a short address like "3 Latitude Way,
  // Corona, CA 92881" must match >= 4 of its 6 tokens, not just the trailing
  // "Corona, CA, 92881" of an unrelated address).
  const minRequired = Math.max(4, Math.ceil(tTokens.length * 0.6));
  if (best && best.count >= minRequired) {
    return { start: best.start, end: best.end, matchedTokens: best.count };
  }
  return null;
}

export function isPurelyNumeric(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return /^[$£€]?[\d,]+(?:\.\d+)?%?$/.test(trimmed);
}

/**
 * If the AI's quote contains "..." or "…" it's signaling two non-contiguous
 * fragments. Split the candidate at those markers and return each segment
 * (descending by length) so the matcher can try each fragment as its own
 * exact-text target. The longest matched fragment becomes the highlight.
 */
export function expandEllipsisSegments(c: string): string[] {
  if (!/[…]|\.{3,}/.test(c)) return [];
  const parts = c
    .split(/\s*\.{3,}\s*|\s*…\s*/g)
    .map((p) => p.trim())
    .filter((p) => p.length >= 12);
  // Sort descending so the longer (more uniquely-matching) segment is tried first.
  parts.sort((a, b) => b.length - a.length);
  return parts;
}

export function expandCandidate(c: string): string[] {
  const out = new Set<string>([c]);
  for (const dv of expandDateVariants(c)) out.add(dv);
  for (const seg of expandEllipsisSegments(c)) out.add(seg);
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

export interface MatchSpan {
  itemIndex: number;
  charStart: number;
  charEnd: number;
}

export interface ItemMatchResult {
  kind: MatchKind;
  candidate?: string;
  variant?: string;
  spans: MatchSpan[];
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

// ============================================================
// Item-level matcher — used by PdfViewer (with pdfjs items) and the
// E2E harness (with the same items from Node-side pdfjs). One source
// of truth for both production and validation.
// ============================================================

interface NormalizedHaystack {
  combined: string;
  charOriginItem: number[];
  charOriginIndex: number[];
  combinedDigits: string;
  digitOriginItem: number[];
  digitOriginIndex: number[];
}

function buildItemHaystacks(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): NormalizedHaystack {
  let combined = '';
  const charOriginItem: number[] = [];
  const charOriginIndex: number[] = [];

  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    const original = items[itemIdx].str ?? '';

    // Inter-item boundary handling. Insert a single space UNLESS both ends
    // of the boundary are alphanumeric AND neither raw item has whitespace
    // at the boundary AND the previous item didn't mark end-of-line — that
    // combination signals pdfjs split the SAME word across items (e.g.
    // ["La", "titude"] from a font/style change), so no boundary space.
    // Otherwise (line break, punctuation, leading/trailing space) keep
    // the space so adjacent line-ending and line-starting words don't fuse
    // into a single false token (e.g. "then" + "fair" → "thenfair").
    if (combined.length > 0 && !combined.endsWith(' ')) {
      const prevChar = combined[combined.length - 1];
      const nextRawChar = original[0] ?? '';
      const prevAlnum = /[\p{L}\p{N}]/u.test(prevChar);
      const nextAlnum = /[\p{L}\p{N}]/u.test(nextRawChar);
      const prevRawEndsWithSpace = (items[itemIdx - 1]?.str ?? '').endsWith(' ');
      const currentRawStartsWithSpace = original.startsWith(' ');
      const prevHadEOL = items[itemIdx - 1]?.hasEOL === true;
      const fuseIntraWord =
        prevAlnum && nextAlnum &&
        !prevRawEndsWithSpace && !currentRawStartsWithSpace &&
        !prevHadEOL;
      if (!fuseIntraWord) {
        combined += ' ';
        charOriginItem.push(-1);
        charOriginIndex.push(-1);
      }
    }

    let lastWasSpace = combined.endsWith(' ') || combined.length === 0;
    for (let ci = 0; ci < original.length; ci++) {
      const norm = normalizeChar(original[ci]);
      if (norm === ' ' && lastWasSpace) continue;
      combined += norm;
      charOriginItem.push(itemIdx);
      charOriginIndex.push(ci);
      lastWasSpace = norm === ' ';
    }
  }

  let combinedDigits = '';
  const digitOriginItem: number[] = [];
  const digitOriginIndex: number[] = [];
  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    const original = items[itemIdx].str ?? '';
    for (let ci = 0; ci < original.length; ci++) {
      if (/\d/.test(original[ci])) {
        combinedDigits += original[ci];
        digitOriginItem.push(itemIdx);
        digitOriginIndex.push(ci);
      }
    }
  }

  return { combined, charOriginItem, charOriginIndex, combinedDigits, digitOriginItem, digitOriginIndex };
}

function spansFromNormalizedRange(h: NormalizedHaystack, pos: number, end: number): MatchSpan[] {
  const byItem = new Map<number, { min: number; max: number }>();
  for (let i = pos; i < end; i++) {
    const item = h.charOriginItem[i];
    const orig = h.charOriginIndex[i];
    if (item < 0) continue;
    const cur = byItem.get(item);
    if (!cur) byItem.set(item, { min: orig, max: orig });
    else {
      if (orig < cur.min) cur.min = orig;
      if (orig > cur.max) cur.max = orig;
    }
  }
  const out: MatchSpan[] = [];
  byItem.forEach((range, itemIndex) => {
    out.push({ itemIndex, charStart: range.min, charEnd: range.max + 1 });
  });
  return out;
}

function spansFromDigitRange(h: NormalizedHaystack, pos: number, end: number): MatchSpan[] {
  const byItem = new Map<number, { min: number; max: number }>();
  for (let i = pos; i < end; i++) {
    const item = h.digitOriginItem[i];
    const orig = h.digitOriginIndex[i];
    if (item < 0) continue;
    const cur = byItem.get(item);
    if (!cur) byItem.set(item, { min: orig, max: orig });
    else {
      if (orig < cur.min) cur.min = orig;
      if (orig > cur.max) cur.max = orig;
    }
  }
  const out: MatchSpan[] = [];
  byItem.forEach((range, itemIndex) => {
    // For "44,833" the digits span chars 0,1,3,4,5; min/max gives 0..5
    // which correctly covers the comma in between.
    out.push({ itemIndex, charStart: range.min, charEnd: range.max + 1 });
  });
  return out;
}

/**
 * Item-level highlight matcher. Mirrors the candidate-side strategy of
 * findHighlightSpans but resolves matches into per-pdfjs-item character
 * spans suitable for slicing each item's str at exact boundaries.
 *
 * Used by PdfViewer's customTextRenderer and by the E2E harness so both
 * stay in lockstep — no test-vs-prod drift.
 */
export function findHighlightSpansForItems(
  items: ReadonlyArray<{ str?: string }>,
  candidates: Array<string | undefined>
): ItemMatchResult {
  const cleaned = candidates.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  if (cleaned.length === 0) return { kind: 'no-candidates', spans: [] };

  // By convention, the LAST candidate is source_text (the AI's verbatim
  // citation) and earlier candidates are field values. If source_text is
  // a meta-summary ("Multiple ... across Paragraphs ...", "See Paragraph
  // 52..."), it won't appear verbatim in the PDF and its value (often a
  // paraphrase) won't either. We try Phase 1 anyway in case the value
  // happens to match exactly, then short-circuit to spans-sections.
  const fallbackSrc = cleaned[cleaned.length - 1];
  const sourceIsMeta = isMetaSummary(fallbackSrc);

  // Phase 0a — if EVERY candidate is meta-summary, short-circuit early.
  if (cleaned.every((c) => isMetaSummary(c))) {
    return { kind: 'spans-sections', spans: [] };
  }

  if (items.length === 0) return { kind: 'not-found', candidate: cleaned[0], spans: [] };
  const h = buildItemHaystacks(items);

  // Phase 1 — exact text match across all candidates and variants.
  for (const candidate of cleaned) {
    if (isTooGenericValue(candidate)) continue;
    for (const variant of expandCandidate(candidate)) {
      const normalized = normalizeForMatch(variant);
      if (normalized.length < 3) continue;
      const pos = h.combined.indexOf(normalized);
      if (pos !== -1) {
        const spans = spansFromNormalizedRange(h, pos, pos + normalized.length);
        if (spans.length > 0) {
          return { kind: 'exact-text', candidate, variant, spans };
        }
      }
    }
  }

  // Phase 2 — digits-only haystack (purely-numeric candidates only).
  for (const candidate of cleaned) {
    if (!isPurelyNumeric(candidate)) continue;
    const variantDigits = candidate.replace(/[^\d]/g, '');
    if (variantDigits.length < 3) continue;
    const dpos = h.combinedDigits.indexOf(variantDigits);
    if (dpos !== -1) {
      const spans = spansFromDigitRange(h, dpos, dpos + variantDigits.length);
      if (spans.length > 0) {
        return { kind: 'digits-only', candidate, variant: variantDigits, spans };
      }
    }
  }

  // Phase 1.5 — token-fuzzy match. Handles pdfjs font-glyph errors
  // ("LaƟtude" vs "Latitude"), OCR variations, intra-word splits, and
  // minor punctuation drift. Tries candidates in their original order
  // (value first, source_text second), preferring the value's tighter
  // match over source_text's broader context. For ellipsis-bridged AI
  // quotes ("Lessee shall not... or sublet..."), each non-trivial segment
  // is tried as its own fuzzy target.
  for (const candidate of cleaned) {
    if (isTooGenericValue(candidate)) continue;
    if (isMetaSummary(candidate)) continue;
    const fuzzyTries = [candidate, ...expandEllipsisSegments(candidate)];
    for (const target of fuzzyTries) {
      const fuzzy = findFuzzyTokenRun(h.combined, target);
      if (fuzzy) {
        const spans = spansFromNormalizedRange(h, fuzzy.start, fuzzy.end);
        if (spans.length > 0) {
          return { kind: 'exact-text', candidate, variant: target, spans };
        }
      }
    }
  }

  // Phase 0b — if all earlier phases found nothing AND source_text is a
  // meta-summary, surface spans-sections (rather than falling through to
  // a longest-substring fallback that would highlight noise).
  if (sourceIsMeta) {
    return { kind: 'spans-sections', spans: [] };
  }

  // Phase 3 — longest-substring fallback on source_text.
  const fallbackTarget = normalizeForMatch(fallbackSrc);
  const minFallbackLen = Math.max(20, Math.floor(fallbackTarget.length * 0.5));
  const longest = findLongestPhrase(h.combined, fallbackTarget, minFallbackLen);
  if (longest) {
    const spans = spansFromNormalizedRange(h, longest.start, longest.end);
    if (spans.length > 0) {
      return { kind: 'longest-substring', candidate: fallbackSrc, spans };
    }
  }

  return { kind: 'not-found', candidate: cleaned[0], spans: [] };
}

/**
 * Reconstruct a debug-readable string of the highlighted text by slicing
 * each item at the per-item char boundaries. NOT used by the production
 * renderer — `customTextRenderer` in PdfViewer wraps each item's char
 * range in <mark> independently, so each highlight sits at its own visual
 * position regardless of how this function joins them.
 *
 * Always inserts a single space between items for human readability.
 * Compare against expected text using a normalization that ignores
 * whitespace differences (e.g. strip non-alphanumeric, lowercase).
 */
export function reconstructHighlight(
  items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>,
  spans: MatchSpan[]
): string {
  const sorted = [...spans].sort((a, b) => a.itemIndex - b.itemIndex);
  return sorted
    .map((s) => {
      const str = items[s.itemIndex]?.str ?? '';
      const start = Math.max(0, Math.min(s.charStart, str.length));
      const end = Math.max(start, Math.min(s.charEnd, str.length));
      return str.slice(start, end);
    })
    .join(' ');
}
