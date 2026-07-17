import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Polish walkthrough 2026-07-17 (commit 9bce71a, cluster 3) — tab-strip
// overflow. At moderate widths the "ASC 842" tab simply didn't exist (clipped
// with no scroll cue), and a too-wide child let the whole page body pan
// sideways, blanking the workbench. Pins: the shared ScrollableTabStrip owns
// horizontal overflow (with edge-fade cues + active-into-view), AppLayout's
// <main> refuses to scroll sideways, and both lease workbenches actually use
// the shared strip.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('cluster 3 — ScrollableTabStrip is the shared owner of tab overflow', () => {
  const strip = read('src/components/ui/scrollable-tabs.tsx');

  it('exports ScrollableTabStrip and UNDERLINE_TAB_TRIGGER', () => {
    expect(strip).toContain('export function ScrollableTabStrip');
    expect(strip).toContain('export const UNDERLINE_TAB_TRIGGER');
  });

  it('the strip itself scrolls horizontally (overflow never leaks to the page)', () => {
    expect(strip).toContain('overflow-x-auto');
  });

  it('clipped tabs announce themselves via edge fades', () => {
    expect(strip).toContain('canScrollLeft');
    expect(strip).toContain('canScrollRight');
  });

  it('the active tab is scrolled into view on activation', () => {
    expect(strip).toMatch(/\[role="tab"\]\[data-state="active"\]/);
    expect(strip).toContain('scrollIntoView');
  });

  it('UNDERLINE_TAB_TRIGGER styles activation as an underline, not a pill', () => {
    expect(strip).toMatch(/UNDERLINE_TAB_TRIGGER =[\s\S]{0,200}data-\[state=active\]:border-primary/);
  });
});

describe('cluster 3 — the page body never scrolls sideways', () => {
  // overflow-x-CLIP, not hidden: `hidden` would make <main> a scroll
  // container and kill position:sticky on every window-scrolled page
  // (layout review HIGH). Pin the corrected property.
  it('AppLayout <main> includes overflow-x-clip (never overflow-x-hidden)', () => {
    const layout = read('src/components/layout/AppLayout.tsx');
    // Narrow to the <main> element's className block.
    const main = layout.slice(layout.indexOf('<main'), layout.indexOf('paddingLeft: mainPaddingLeft'));
    expect(main).toContain('overflow-x-clip');
    expect(main).not.toContain('overflow-x-hidden');
  });
});

describe('cluster 3 — both lease workbenches use the shared strip', () => {
  for (const p of [
    'src/pages/app/LeaseReview.tsx',
    'src/components/leases/locked/LockedLeaseDetail.tsx',
  ]) {
    it(`${p} imports and mounts ScrollableTabStrip with the active value`, () => {
      const src = read(p);
      expect(src).toContain("import { ScrollableTabStrip, UNDERLINE_TAB_TRIGGER } from '@/components/ui/scrollable-tabs';");
      expect(src).toContain('<ScrollableTabStrip activeValue={activeTab}');
      expect(src).toContain('UNDERLINE_TAB_TRIGGER');
    });
  }
});
