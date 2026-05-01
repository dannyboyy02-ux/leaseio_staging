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
  /** When set, text on the rendered page that matches this string is wrapped
   *  in a yellow <mark> highlight so the user can see the AI extraction's
   *  source for the field they clicked. */
  targetHighlight?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Normalize a string for substring matching: collapse whitespace, lowercase,
 * strip punctuation. Used to find the source phrase inside the page's
 * concatenated text without being thrown off by curly quotes / hyphenation.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
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

export function PdfViewer({ url, targetPage, targetHighlight }: PdfViewerProps) {
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
    setMatchRange(null);
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

  // Item-index range that overlaps the matched source phrase. Recomputed
  // whenever the loaded page changes OR targetHighlight changes — clicking a
  // different field on the same page must re-highlight, but the page itself
  // doesn't remount, so we can't rely on onPageLoadSuccess alone.
  const [matchRange, setMatchRange] = useState<{ start: number; end: number } | null>(null);
  // 'searching' = waiting for page to load, 'found' = highlight rendered,
  // 'not-found' = phrase not located in this page's text layer. Drives the
  // small status pill so the user understands why a click did nothing.
  const [matchStatus, setMatchStatus] = useState<'idle' | 'searching' | 'found' | 'not-found'>('idle');
  const pageRef = useRef<any>(null);

  const computeMatchRange = useCallback(async (page: any, phrase?: string) => {
    if (!page) return;
    if (!phrase) {
      setMatchRange(null);
      setMatchStatus('idle');
      return;
    }
    setMatchStatus('searching');
    try {
      const textContent = await page.getTextContent();
      const items: Array<{ str: string }> = textContent?.items ?? [];
      if (items.length === 0) {
        setMatchRange(null);
        setMatchStatus('not-found');
        return;
      }

      // Build a normalized concatenated string with per-item char ranges.
      let combined = '';
      const itemRanges: Array<{ start: number; end: number }> = [];
      for (const item of items) {
        const piece = normalizeForMatch(item.str ?? '');
        const start = combined.length;
        // Pad with a single space between items so adjacent words don't fuse.
        const fragment = piece.length > 0 ? piece + ' ' : ' ';
        combined += fragment;
        itemRanges.push({ start, end: start + piece.length });
      }

      const normalizedTarget = normalizeForMatch(phrase);
      if (normalizedTarget.length < 4) {
        setMatchRange(null);
        setMatchStatus('not-found');
        return;
      }

      // Try a full-phrase match first; fall back to the longest substring.
      let pos = combined.indexOf(normalizedTarget);
      let matchLen = normalizedTarget.length;
      if (pos === -1) {
        const longest = findLongestPhrase(combined, normalizedTarget, 8);
        if (!longest) {
          setMatchRange(null);
          setMatchStatus('not-found');
          return;
        }
        pos = longest.start;
        matchLen = longest.end - longest.start;
      }

      // Map char range back to item indices.
      const matchEnd = pos + matchLen;
      let startIdx = -1;
      let endIdx = -1;
      for (let i = 0; i < itemRanges.length; i++) {
        const r = itemRanges[i];
        if (r.end <= pos || r.start >= matchEnd) continue;
        if (startIdx === -1) startIdx = i;
        endIdx = i;
      }
      if (startIdx === -1) {
        setMatchRange(null);
        setMatchStatus('not-found');
      } else {
        setMatchRange({ start: startIdx, end: endIdx });
        setMatchStatus('found');
      }
    } catch (err) {
      console.error('[PdfViewer] Failed to compute highlight range:', err);
      setMatchRange(null);
      setMatchStatus('not-found');
    }
  }, []);

  const onPageLoadSuccess = useCallback(
    async (page: any) => {
      pageRef.current = page;
      await computeMatchRange(page, targetHighlight);
    },
    [computeMatchRange, targetHighlight]
  );

  // Re-run the matcher when targetHighlight changes for the SAME page —
  // the Page doesn't remount, so onPageLoadSuccess won't fire again on its own.
  useEffect(() => {
    if (pageRef.current) {
      computeMatchRange(pageRef.current, targetHighlight);
    }
  }, [targetHighlight, computeMatchRange]);

  const customTextRenderer = useCallback(
    ({ str, itemIndex }: { str: string; itemIndex: number }) => {
      if (!matchRange || str === '') return escapeHtml(str);
      if (itemIndex < matchRange.start || itemIndex > matchRange.end) return escapeHtml(str);
      return `<mark class="ai-source-highlight">${escapeHtml(str)}</mark>`;
    },
    [matchRange]
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
          {targetHighlight && (
            <span
              className={
                matchStatus === 'found'
                  ? 'ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-100 text-yellow-800'
                  : matchStatus === 'searching'
                    ? 'ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground'
                    : matchStatus === 'not-found'
                      ? 'ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200'
                      : 'hidden'
              }
              title={matchStatus === 'not-found' ? `Source phrase not located on this page: "${targetHighlight.slice(0, 60)}…"` : undefined}
            >
              {matchStatus === 'found' && 'Source highlighted'}
              {matchStatus === 'searching' && 'Searching…'}
              {matchStatus === 'not-found' && 'Source not located on this page'}
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
              key={`page-${currentPage}-hl-${targetHighlight ?? ''}`}
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
