import { useState, useEffect, useCallback, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Use the bundled worker from the installed package
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface PdfViewerProps {
  url: string | null;
  targetPage?: number; // when this changes, jump to that page
  /** Surrounding-clause context the AI quoted as the source of the field
   *  (e.g. `Five Degrees, LLC, a California limited liability company ("Lessor")`).
   *  Used as a fallback target if `targetValue` cannot be located verbatim. */
  targetHighlight?: string;
  /** The actual extracted field value (e.g. `Five Degrees, LLC, a California
   *  limited liability company`). Tried FIRST so the highlight tightly hugs
   *  the abstracted words instead of the surrounding boilerplate. */
  targetValue?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Normalize a single character for matching: lowercase, treat any non-letter,
 * non-number char as a "word break" (returned as a single space). Returning
 * '' would make the per-char index map ambiguous, so we always return one char.
 */
function normalizeChar(c: string): string {
  const lower = c.toLowerCase();
  if (/[\p{L}\p{N}]/u.test(lower)) return lower;
  return ' ';
}

/**
 * Normalize a whole string the same way `normalizeChar` does, char-by-char.
 * Used for normalizing the user's target phrase before searching. Note: the
 * resulting string may contain runs of spaces; the matcher uses `indexOf` on
 * the same-style normalized haystack, so the runs cancel out as long as we
 * don't collapse them on either side.
 */
function normalizeForMatch(s: string): string {
  let out = '';
  for (const c of s) out += normalizeChar(c);
  // Collapse runs of spaces to single spaces and trim — the haystack is built
  // the same way, so both sides match.
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Find the longest contiguous substring of `target` that appears anywhere in
 * `haystack`. Returns the [start, end) indices inside the normalized haystack,
 * or null if no substring of >= MIN_CHARS chars matches. We start with the
 * full target and shrink; first hit wins.
 */
function findLongestPhrase(haystack: string, target: string, minChars = 12): { start: number; end: number } | null {
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

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Generate textual variants for an ISO-8601 date so it can match how the
 * date is actually written in the PDF (e.g. "March 1, 2023" or "3/1/2023").
 * Returns [] if the input doesn't look like an ISO date.
 */
function expandDateVariants(s: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return [];
  const [, y, mo, d] = m;
  const monthIdx = parseInt(mo, 10) - 1;
  const dayNum = parseInt(d, 10);
  if (monthIdx < 0 || monthIdx > 11 || dayNum < 1 || dayNum > 31) return [];
  const full = MONTHS_FULL[monthIdx];
  const abbr = MONTHS_ABBR[monthIdx];
  const year = y;
  return [
    `${full} ${dayNum}, ${year}`,
    `${full} ${dayNum} ${year}`,
    `${abbr} ${dayNum}, ${year}`,
    `${abbr}. ${dayNum}, ${year}`,
    `${parseInt(mo, 10)}/${dayNum}/${year}`,
    `${mo}/${d}/${year}`,
    `${parseInt(mo, 10)}-${dayNum}-${year}`,
    `${dayNum} ${full} ${year}`,
  ];
}

/**
 * Some short or extremely common single-token values (like "monthly",
 * "yes", "annual") would match dozens of times across a lease and the
 * resulting highlight would be useless or wrong. We skip them as primary
 * targets and rely on source_text matching instead.
 */
const GENERIC_SINGLE_WORDS = new Set([
  'yes', 'no', 'true', 'false', 'na', 'n/a',
  'monthly', 'annual', 'annually', 'quarterly', 'weekly', 'daily', 'biweekly', 'bi-weekly',
  'fixed', 'variable', 'none',
  'active', 'inactive', 'pending', 'expired',
]);

function isTooGenericValue(s: string): boolean {
  const t = s.trim().toLowerCase();
  // Single word, common label.
  if (!/\s/.test(t) && GENERIC_SINGLE_WORDS.has(t)) return true;
  return false;
}

/**
 * Some source_text fields are AI meta-summaries (e.g. "Multiple termination
 * provisions across Paragraphs 2.3, 3.3, ..."). These don't appear verbatim
 * in the PDF, so highlighting is impossible. Detect and surface a clearer
 * "spans multiple sections" signal rather than silently failing.
 */
function isPurelyNumeric(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return /^[$£€]?[\d,]+(?:\.\d+)?%?$/.test(trimmed);
}

function isMetaSummary(s: string): boolean {
  if (!s) return false;
  const t = s.toLowerCase();
  return (
    /^multiple\b.*\bacross\s+paragraphs?\b/i.test(s) ||
    /^see\s+paragraphs?\b/i.test(s) ||
    /^n\s*\/\s*a\b/i.test(s) ||
    /^paragraphs?\s+\d/.test(t) ||
    /\bsee\s+(paragraph|exhibit|schedule|attached)\b/i.test(s)
  );
}

export function PdfViewer({ url, targetPage, targetHighlight, targetValue }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(600);

  // Jump to page when parent requests it
  useEffect(() => {
    if (targetPage && targetPage >= 1 && targetPage <= numPages) {
      setCurrentPage(targetPage);
    }
  }, [targetPage, numPages]);

  // Reset on new document
  useEffect(() => {
    setCurrentPage(1);
    setNumPages(0);
    setError(null);
    pageRef.current = null;
    setMatchSpans(null);
  }, [url]);

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setError(null);
  }, []);

  const onDocumentLoadError = useCallback((err: Error) => {
    console.error('[PdfViewer] Load error:', err);
    setError(err.message || 'Failed to load document');
  }, []);

  const prevPage = () => setCurrentPage(p => Math.max(1, p - 1));
  const nextPage = () => setCurrentPage(p => Math.min(numPages, p + 1));

  // Per-pdfjs-text-item character spans that the matcher wants highlighted.
  // Char-level so the <mark> hugs the matched substring exactly, even when a
  // pdfjs item contains a long line of which only a few words match.
  type MatchSpan = { itemIndex: number; charStart: number; charEnd: number };
  const [matchSpans, setMatchSpans] = useState<MatchSpan[] | null>(null);
  // 'searching' = waiting for page to load, 'found' = highlight rendered,
  // 'not-found' = phrase not located in this page's text layer,
  // 'spans-sections' = source_text is a meta-summary (e.g. "across Paragraphs 9.3, 9.4")
  // and there's no single phrase to highlight. Drives the toolbar pill.
  const [matchStatus, setMatchStatus] = useState<'idle' | 'searching' | 'found' | 'not-found' | 'spans-sections'>('idle');
  const pageRef = useRef<any>(null);

  /**
   * Try to locate one of the candidate phrases in the page's text layer.
   * Candidates tried in order — the first one with an exact match wins.
   * Falls back to the longest substring of source_text only if it's long
   * enough to be unique-ish (avoids highlighting random "limited liability"
   * matches scattered across the page).
   *
   * Returns per-item character spans so the <mark> hugs matched chars
   * within an item rather than wrapping the whole item.
   */
  const computeMatchRange = useCallback(
    async (page: any, candidates: Array<string | undefined>) => {
      if (!page) return;
      const cleaned = candidates.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
      if (cleaned.length === 0) {
        setMatchSpans(null);
        setMatchStatus('idle');
        return;
      }
      setMatchStatus('searching');
      try {
        const textContent = await page.getTextContent();
        const items: Array<{ str: string }> = textContent?.items ?? [];
        if (items.length === 0) {
          setMatchSpans(null);
          setMatchStatus('not-found');
          return;
        }

        // Build a normalized concatenated string. For each char in the
        // normalized output, store (itemIndex, originalCharIndex) so once
        // we know the normalized [pos, end) of a match we can map back to
        // exact char offsets within each pdfjs item's original `str`.
        let combined = '';
        const charOriginItem: number[] = []; // length = combined.length
        const charOriginIndex: number[] = []; // length = combined.length

        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          const original = items[itemIdx].str ?? '';
          let lastWasSpace = combined.endsWith(' ') || combined.length === 0;
          for (let ci = 0; ci < original.length; ci++) {
            const norm = normalizeChar(original[ci]);
            // Skip duplicate spaces — keep the haystack collapse-equivalent
            // to normalizeForMatch on the target side.
            if (norm === ' ' && lastWasSpace) continue;
            combined += norm;
            charOriginItem.push(itemIdx);
            charOriginIndex.push(ci);
            lastWasSpace = norm === ' ';
          }
          // Insert an inter-item boundary space so adjacent items don't fuse.
          if (!lastWasSpace) {
            combined += ' ';
            charOriginItem.push(-1); // boundary, not part of any item
            charOriginIndex.push(-1);
          }
        }
        // Trim trailing space for cleanliness; but we don't need to mutate
        // the parallel arrays since we never index past combined.length.

        /** Translate a normalized [pos, end) range to per-item MatchSpans. */
        const buildSpans = (pos: number, end: number): MatchSpan[] | null => {
          if (pos < 0 || end <= pos || end > combined.length) return null;
          const byItem = new Map<number, { min: number; max: number }>();
          for (let i = pos; i < end; i++) {
            const item = charOriginItem[i];
            const orig = charOriginIndex[i];
            if (item < 0) continue;
            const cur = byItem.get(item);
            if (!cur) byItem.set(item, { min: orig, max: orig });
            else {
              if (orig < cur.min) cur.min = orig;
              if (orig > cur.max) cur.max = orig;
            }
          }
          if (byItem.size === 0) return null;
          const out: MatchSpan[] = [];
          byItem.forEach((range, itemIndex) => {
            out.push({ itemIndex, charStart: range.min, charEnd: range.max + 1 });
          });
          return out;
        };

        // Expand each candidate into match variants. For numeric values,
        // add comma-formatted (44,833) and digit-only (44833) variants. For
        // ISO dates, add textual representations ("March 1, 2023" etc.) so
        // a stored value of "2023-03-01" matches what the PDF actually says.
        // CRITICAL: digit-only variants ONLY for candidates that are
        // themselves purely numeric — otherwise an address like
        // "3 Latitude Way, Corona, CA 92881" synthesizes "392881" and
        // Phase 1 would match those random digits in sequence anywhere
        // they appear, highlighting just the street number and zip.
        const expandCandidate = (c: string): string[] => {
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
          if (isPurelyNumeric(c)) {
            const digitsOnly = c.replace(/[^\d]/g, '');
            if (digitsOnly.length >= 3) out.add(digitsOnly);
          }
          return Array.from(out).filter((s) => s.trim().length > 0);
        };

        // Build a digits-only haystack alongside the normalized one so that
        // numeric targets locate cleanly even when the PDF inserts commas
        // or currency symbols between the digits.
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

        const buildSpansFromDigits = (pos: number, len: number): MatchSpan[] | null => {
          if (pos < 0 || len <= 0 || pos + len > combinedDigits.length) return null;
          const byItem = new Map<number, { min: number; max: number }>();
          for (let i = pos; i < pos + len; i++) {
            const item = digitOriginItem[i];
            const orig = digitOriginIndex[i];
            if (item < 0) continue;
            const cur = byItem.get(item);
            if (!cur) byItem.set(item, { min: orig, max: orig });
            else {
              if (orig < cur.min) cur.min = orig;
              if (orig > cur.max) cur.max = orig;
            }
          }
          if (byItem.size === 0) return null;
          const out: MatchSpan[] = [];
          byItem.forEach((range, itemIndex) => {
            // For a numeric match within an item like "44,833", the digit
            // chars are at indices 0,1,3,4,5; min/max gives 0..5 which
            // correctly covers the comma in between.
            out.push({ itemIndex, charStart: range.min, charEnd: range.max + 1 });
          });
          return out;
        };

        // Phase 0 — short-circuit: if the only candidate is a meta-summary
        // ("Multiple ... across Paragraphs ..."), don't try to highlight
        // (it won't appear verbatim in the PDF) and surface a clear pill.
        const lastCandidate = cleaned[cleaned.length - 1];
        const allCandidatesMeta = cleaned.every((c) => isMetaSummary(c));
        if (allCandidatesMeta || (cleaned.length === 1 && isMetaSummary(lastCandidate))) {
          setMatchSpans(null);
          setMatchStatus('spans-sections');
          return;
        }

        // Phase 1 — try EXACT normalized-text matches across every candidate
        // and its format variants. Skip overly-generic single-word values
        // (like "monthly") that would match indiscriminately — let source_text
        // win for those.
        for (const candidate of cleaned) {
          if (isTooGenericValue(candidate)) continue;
          for (const variant of expandCandidate(candidate)) {
            const normalized = normalizeForMatch(variant);
            if (normalized.length < 3) continue;
            const pos = combined.indexOf(normalized);
            if (pos !== -1) {
              const spans = buildSpans(pos, pos + normalized.length);
              if (spans) {
                setMatchSpans(spans);
                setMatchStatus('found');
                return;
              }
            }
          }
        }

        // Phase 2 — digits-only haystack match. Only run when the candidate
        // itself is purely numeric (e.g. square_footage = "44833", rent =
        // "$69,491.15"). For text candidates that merely contain digits
        // (street addresses, descriptions), this path produces garbage —
        // matching only the digits in isolation — so we skip it there.
        for (const candidate of cleaned) {
          if (!isPurelyNumeric(candidate)) continue;
          const variantDigits = candidate.replace(/[^\d]/g, '');
          if (variantDigits.length < 3) continue;
          const dpos = combinedDigits.indexOf(variantDigits);
          if (dpos !== -1) {
            const spans = buildSpansFromDigits(dpos, variantDigits.length);
            if (spans) {
              setMatchSpans(spans);
              setMatchStatus('found');
              return;
            }
          }
        }

        // Strict fallback: longest-substring match on source_text (last
        // candidate), but only if the matched substring is long enough that
        // false positives are unlikely.
        const fallbackSrc = cleaned[cleaned.length - 1];
        const fallbackTarget = normalizeForMatch(fallbackSrc);
        const minFallbackLen = Math.max(20, Math.floor(fallbackTarget.length * 0.5));
        const longest = findLongestPhrase(combined, fallbackTarget, minFallbackLen);
        if (longest) {
          const spans = buildSpans(longest.start, longest.end);
          if (spans) {
            setMatchSpans(spans);
            setMatchStatus('found');
            return;
          }
        }

        setMatchSpans(null);
        setMatchStatus('not-found');
      } catch (err) {
        console.error('[PdfViewer] Failed to compute highlight range:', err);
        setMatchSpans(null);
        setMatchStatus('not-found');
      }
    },
    []
  );

  const onPageLoadSuccess = useCallback(
    async (page: any) => {
      pageRef.current = page;
      await computeMatchRange(page, [targetValue, targetHighlight]);
    },
    [computeMatchRange, targetValue, targetHighlight]
  );

  // Re-run the matcher when either highlight target changes for the SAME page —
  // the Page doesn't remount, so onPageLoadSuccess won't fire again on its own.
  useEffect(() => {
    if (pageRef.current) {
      computeMatchRange(pageRef.current, [targetValue, targetHighlight]);
    }
  }, [targetValue, targetHighlight, computeMatchRange]);

  const customTextRenderer = useCallback(
    ({ str, itemIndex }: { str: string; itemIndex: number }) => {
      if (!matchSpans || str === '') return escapeHtml(str);
      const span = matchSpans.find((s) => s.itemIndex === itemIndex);
      if (!span) return escapeHtml(str);
      const safeStart = Math.max(0, Math.min(span.charStart, str.length));
      const safeEnd = Math.max(safeStart, Math.min(span.charEnd, str.length));
      const before = str.slice(0, safeStart);
      const hit = str.slice(safeStart, safeEnd);
      const after = str.slice(safeEnd);
      return `${escapeHtml(before)}<mark class="ai-source-highlight">${escapeHtml(hit)}</mark>${escapeHtml(after)}`;
    },
    [matchSpans]
  );
  const zoomIn  = () => setScale(s => Math.min(2.5, parseFloat((s + 0.2).toFixed(1))));
  const zoomOut = () => setScale(s => Math.max(0.5, parseFloat((s - 0.2).toFixed(1))));

  if (!url) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Document unavailable
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
        <p className="text-sm text-destructive font-medium">Could not load document</p>
        <p className="text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b bg-background shrink-0">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={prevPage} disabled={currentPage <= 1}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {numPages > 0 ? `${currentPage} / ${numPages}` : '—'}
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={nextPage} disabled={currentPage >= numPages}>
            <ChevronRight size={14} />
          </Button>
          {(targetValue || targetHighlight) && (
            <span
              className={
                matchStatus === 'found'
                  ? 'ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-800'
                  : matchStatus === 'searching'
                    ? 'ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground'
                    : matchStatus === 'not-found'
                      ? 'ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200'
                      : matchStatus === 'spans-sections'
                        ? 'ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200'
                        : 'hidden'
              }
              title={
                matchStatus === 'not-found'
                  ? `Source not located on this page: "${(targetValue || targetHighlight || '').slice(0, 60)}…"`
                  : matchStatus === 'spans-sections'
                    ? `The AI flagged this as spanning multiple sections; no single phrase to highlight.`
                    : undefined
              }
            >
              {matchStatus === 'found' && 'Source highlighted'}
              {matchStatus === 'searching' && 'Searching…'}
              {matchStatus === 'not-found' && 'Source not located on this page'}
              {matchStatus === 'spans-sections' && 'Source spans multiple sections'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={zoomOut} disabled={scale <= 0.5}>
            <ZoomOut size={14} />
          </Button>
          <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(scale * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={zoomIn} disabled={scale >= 2.5}>
            <ZoomIn size={14} />
          </Button>
        </div>
      </div>

      {/* Document */}
      <div className="flex-1 overflow-auto bg-muted/30 p-2">
        <div className="w-fit mx-auto">
          <Document
            file={url}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading document…
              </div>
            }
          >
            <Page
              key={`page-${currentPage}-v-${targetValue ?? ''}-hl-${targetHighlight ?? ''}`}
              pageNumber={currentPage}
              scale={scale}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              customTextRenderer={customTextRenderer}
              onLoadSuccess={onPageLoadSuccess}
              loading={
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              }
            />
          </Document>
        </div>
      </div>
    </div>
  );
}
