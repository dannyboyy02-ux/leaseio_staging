import { useState, useEffect, useCallback, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { findHighlightSpansForItems, type MatchSpan as SharedMatchSpan } from './pdfHighlightMatcher';

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
  /** When true, the viewer enters "capture mode" — a floating button appears
   *  whenever the user has selected text on the rendered page. Click → fires
   *  `onCaptureSelection(currentPage, selectedText)` so the parent can
   *  attach the selection to a user-added risk citation. */
  captureMode?: boolean;
  onCaptureSelection?: (page: number, text: string) => void;
  /** Called when the user explicitly cancels capture mode without
   * making a selection. Parent should set captureMode back to false
   * while keeping any host dialog (e.g. AddRiskDialog) open. */
  onExitCapture?: () => void;
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

/**
 * Split AI quotes containing "..." or "…" into the longest non-trivial
 * sub-fragments — those ARE present verbatim in the PDF; the ellipsis
 * just marks where the AI omitted intervening text.
 */
function expandEllipsisSegments(c: string): string[] {
  if (!/[…]|\.{3,}/.test(c)) return [];
  const parts = c
    .split(/\s*\.{3,}\s*|\s*…\s*/g)
    .map((p) => p.trim())
    .filter((p) => p.length >= 12);
  parts.sort((a, b) => b.length - a.length);
  return parts;
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

export function PdfViewer({ url, targetPage, targetHighlight, targetValue, captureMode, onCaptureSelection, onExitCapture }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(600);
  // Holds the pdfjs Document proxy so we can fetch any page's text content
  // for cross-page source search (handles AI page-citation errors).
  const pdfDocRef = useRef<any>(null);
  // Cache page text content so cross-page search doesn't re-fetch.
  const pageItemsCache = useRef<Map<number, Array<{ str: string; hasEOL?: boolean }>>>(new Map());
  // Tracks the page where the match landed (may differ from targetPage if
  // the AI cited the wrong page and the matcher found the source elsewhere).
  const [foundOnPage, setFoundOnPage] = useState<number | null>(null);

  // Reset on new document
  useEffect(() => {
    setCurrentPage(1);
    setNumPages(0);
    setError(null);
    pageRef.current = null;
    setMatchSpans(null);
    setFoundOnPage(null);
    pdfDocRef.current = null;
    pageItemsCache.current.clear();
  }, [url]);

  const onDocumentLoadSuccess = useCallback((doc: any) => {
    pdfDocRef.current = doc;
    setNumPages(doc.numPages);
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
  const [matchSpans, setMatchSpans] = useState<SharedMatchSpan[] | null>(null);
  // 'searching' = waiting for page to load, 'found' = highlight rendered,
  // 'not-found' = phrase not located in this page's text layer,
  // 'spans-sections' = source_text is a meta-summary (e.g. "across Paragraphs 9.3, 9.4")
  // and there's no single phrase to highlight. Drives the toolbar pill.
  const [matchStatus, setMatchStatus] = useState<'idle' | 'searching' | 'found' | 'not-found' | 'spans-sections'>('idle');
  const pageRef = useRef<any>(null);
  // Capture-mode state: tracks the latest non-empty selection within the
  // viewer container so a floating action button can render at the right
  // edge of the toolbar.
  const containerRef = useRef<HTMLDivElement>(null);
  const [pendingSelectionText, setPendingSelectionText] = useState<string>('');

  // Selection listener — only active when captureMode is on.
  useEffect(() => {
    if (!captureMode) {
      setPendingSelectionText('');
      return;
    }
    const handler = () => {
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPendingSelectionText('');
        return;
      }
      // Only treat the selection as "live" if it actually intersects the
      // viewer's text layer — not selections made elsewhere in the page.
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (container && container.contains(range.commonAncestorContainer)) {
        const text = sel.toString().trim();
        setPendingSelectionText(text.length >= 3 ? text : '');
      } else {
        setPendingSelectionText('');
      }
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [captureMode]);

  // Escape exits capture mode — universal expectation for any modal-ish
  // selection state. Mirrors the Cancel button in the amber bar.
  useEffect(() => {
    if (!captureMode || !onExitCapture) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onExitCapture();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [captureMode, onExitCapture]);

  const confirmCapture = () => {
    if (!pendingSelectionText || !onCaptureSelection) return;
    onCaptureSelection(currentPage, pendingSelectionText);
    setPendingSelectionText('');
    if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges();
  };

  /**
   * Load a single page's text-content items (cached). Returns null on failure.
   */
  const getPageItems = useCallback(
    async (pageNumber: number): Promise<Array<{ str: string; hasEOL?: boolean }> | null> => {
      const cache = pageItemsCache.current;
      if (cache.has(pageNumber)) return cache.get(pageNumber)!;
      const doc = pdfDocRef.current;
      if (!doc) return null;
      if (pageNumber < 1 || pageNumber > doc.numPages) return null;
      try {
        const page = await doc.getPage(pageNumber);
        const tc = await page.getTextContent();
        const items = (tc?.items ?? [])
          .filter((i: any) => 'str' in i)
          .map((i: any) => ({ str: i.str ?? '', hasEOL: i.hasEOL ?? false }));
        cache.set(pageNumber, items);
        return items;
      } catch {
        return null;
      }
    },
    []
  );

  /**
   * Cross-page search. Tries the cited page first, then expands outward
   * (±1, ±2, ...) until a meaningful match (exact-text or digits-only or
   * longest-substring) is found. Returns {page, spans, kind} or null.
   *
   * If the AI cited the wrong page (a known pipeline-side issue), this
   * automatically navigates the user to where the source actually is so
   * HITL verification still works.
   */
  const searchAcrossPages = useCallback(
    async (citedPage: number, candidates: Array<string | undefined>): Promise<{ page: number; spans: SharedMatchSpan[]; kind: 'found' | 'spans-sections' | 'not-found' } | null> => {
      const doc = pdfDocRef.current;
      if (!doc) return null;
      const total = doc.numPages as number;

      // Build search order: cited page first, then expanding outward.
      const order: number[] = [citedPage];
      for (let delta = 1; delta < total; delta++) {
        if (citedPage - delta >= 1) order.push(citedPage - delta);
        if (citedPage + delta <= total) order.push(citedPage + delta);
      }

      // Track best result seen so we can degrade gracefully.
      let bestSpansSections: number | null = null;
      // Try each page; first 'found' wins, fall back to 'spans-sections'
      // from the cited page if no real match anywhere.
      for (const p of order) {
        const items = await getPageItems(p);
        if (!items || items.length === 0) continue;
        const result = findHighlightSpansForItems(items, candidates);
        if (
          (result.kind === 'exact-text' || result.kind === 'digits-only' || result.kind === 'longest-substring') &&
          result.spans.length > 0
        ) {
          return { page: p, spans: result.spans, kind: 'found' };
        }
        if (result.kind === 'spans-sections' && bestSpansSections === null) {
          bestSpansSections = p;
        }
      }
      if (bestSpansSections !== null) {
        return { page: bestSpansSections, spans: [], kind: 'spans-sections' };
      }
      return { page: citedPage, spans: [], kind: 'not-found' };
    },
    [getPageItems]
  );

  // When parent updates the targets, search across pages and navigate to
  // wherever the source actually is. Replaces the previous "jump only to
  // cited page" effect — now we ALSO follow up by searching neighbors and
  // the rest of the document if the cited page has nothing.
  useEffect(() => {
    if (!targetPage || numPages === 0) return;
    const candidates: Array<string | undefined> = [targetValue, targetHighlight];
    const hasAny = candidates.some((c) => typeof c === 'string' && c.trim().length > 0);
    if (!hasAny) {
      // No highlight requested — just jump to the cited page.
      setCurrentPage(targetPage);
      setMatchSpans(null);
      setMatchStatus('idle');
      setFoundOnPage(null);
      return;
    }
    setMatchStatus('searching');
    let cancelled = false;
    (async () => {
      const result = await searchAcrossPages(targetPage, candidates);
      if (cancelled || !result) return;
      setCurrentPage(result.page);
      setFoundOnPage(result.kind === 'found' ? result.page : null);
      if (result.kind === 'found') {
        setMatchSpans(result.spans);
        setMatchStatus('found');
      } else if (result.kind === 'spans-sections') {
        setMatchSpans(null);
        setMatchStatus('spans-sections');
      } else {
        setMatchSpans(null);
        setMatchStatus('not-found');
      }
    })();
    return () => { cancelled = true; };
  }, [targetPage, targetValue, targetHighlight, numPages, searchAcrossPages]);

  // Page-load is now a no-op for matching — the cross-page search effect
  // above is the single source of truth that runs the matcher and sets
  // matchSpans/matchStatus before we navigate. We just hold a ref so the
  // page object is reachable for any future single-page API.
  const onPageLoadSuccess = useCallback(async (page: any) => {
    pageRef.current = page;
  }, []);

  const customTextRenderer = useCallback(
    ({ str, itemIndex }: { str: string; itemIndex: number }) => {
      // In capture mode, render plain text — suppress any existing AI-source
      // highlight (matchSpans from a previous Sparkles click). Otherwise the
      // user enters "Highlight in PDF" with a yellow mark already painted on
      // the page, which (a) confuses the intent of the new selection and
      // (b) makes it visually unclear that drag-select is available.
      // Suppressing in the renderer (vs clearing matchSpans state) avoids
      // remounting the Page (which would happen if we cleared targetValue/
      // targetHighlight via the Page key) and therefore preserves the user's
      // in-flight text selection across re-renders.
      if (captureMode) return escapeHtml(str);
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
    [matchSpans, captureMode]
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
    <div ref={containerRef} className={cn('flex flex-col h-full', captureMode && 'ring-2 ring-amber-400/60 rounded')}>
      {captureMode && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900 shrink-0">
          <span className="flex-1 min-w-[180px]">Selection mode — highlight a clause in the PDF, then click <strong>Use selection</strong>. (Esc to cancel.)</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {onExitCapture && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px] border-amber-400 text-amber-900 hover:bg-amber-100"
                onClick={onExitCapture}
              >
                Cancel
              </Button>
            )}
            <Button
              size="sm"
              variant="default"
              className="h-6 text-[11px] bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
              disabled={!pendingSelectionText}
              onClick={confirmCapture}
            >
              Use selection
            </Button>
          </div>
        </div>
      )}
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b bg-background shrink-0">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={prevPage} disabled={currentPage <= 1} title="Previous page" aria-label="Previous page">
            <ChevronLeft size={14} />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {numPages > 0 ? `${currentPage} / ${numPages}` : '—'}
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={nextPage} disabled={currentPage >= numPages} title="Next page" aria-label="Next page">
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
                  ? `Source not located anywhere in this document: "${(targetValue || targetHighlight || '').slice(0, 60)}…"`
                  : matchStatus === 'spans-sections'
                    ? `The AI flagged this as spanning multiple sections; no single phrase to highlight.`
                    : matchStatus === 'found' && targetPage && foundOnPage && foundOnPage !== targetPage
                      ? `AI cited page ${targetPage}; located on page ${foundOnPage} instead.`
                      : undefined
              }
            >
              {matchStatus === 'found' && (foundOnPage && targetPage && foundOnPage !== targetPage
                ? `Source highlighted (page ${foundOnPage}, AI cited ${targetPage})`
                : 'Source highlighted')}
              {matchStatus === 'searching' && 'Searching…'}
              {matchStatus === 'not-found' && 'Source not located in document'}
              {matchStatus === 'spans-sections' && 'Source spans multiple sections'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={zoomOut} disabled={scale <= 0.5} title="Zoom out" aria-label="Zoom out">
            <ZoomOut size={14} />
          </Button>
          <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(scale * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={zoomIn} disabled={scale >= 2.5} title="Zoom in" aria-label="Zoom in">
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
