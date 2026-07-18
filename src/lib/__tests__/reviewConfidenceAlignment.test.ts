import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #177a — review-workbench confidence alignment + jump-to-flagged-field.
// Static pins (repo readFileSync + narrowed-window convention):
//   (a) getFieldBorderClass DERIVES from the shared confidenceTier bands and
//       carries no re-introduced local 0.7x/0.8x thresholds — badge, border,
//       and the review-flag cutoff stay one banding.
//   (b) the per-field wrapper div carries the data-field-id anchor the jump
//       targets (mirrors the data-section-key anchor handleSectionAdvance
//       already uses).
//   (c) handleJumpToFirstFlagged tab-switches via the module-level
//       SECTION_TO_TAB (no re-inlined map), rAF-polls for the anchor, scrolls
//       + focuses the control, and marks the field interacted inside the
//       found-branch only.
// The behavioral layer (tier boundaries themselves) lives in
// extractedFieldHelpers.test.ts.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#177a — field border derives from the shared confidence tiers', () => {
  const sections = read('src/components/leases/LeaseReviewSections.tsx');

  it('getFieldBorderClass calls confidenceTier and has no local numeric thresholds', () => {
    const start = sections.indexOf('const getFieldBorderClass');
    expect(start).toBeGreaterThan(-1);
    // End anchor: the next helper declared after getFieldBorderClass in
    // SectionCard. If it's ever renamed the slice falls back to a fixed
    // window large enough to cover the function.
    const endAnchor = sections.indexOf('const autoResizeRef', start);
    const block = sections.slice(start, endAnchor === -1 ? start + 800 : endAnchor);
    expect(block).toContain('confidenceTier(');
    expect(block).not.toMatch(/0\.[78]/);
  });

  it('the per-field wrapper div carries the data-field-id jump anchor', () => {
    expect(sections).toContain('data-field-id={field.id}');
  });
});

describe('#177a — jump-to-first-flagged scrolls + focuses + marks', () => {
  const review = read('src/pages/app/LeaseReview.tsx');

  it('handleJumpToFirstFlagged uses SECTION_TO_TAB, polls the anchor, scrolls, focuses, and marks in the found-branch', () => {
    const start = review.indexOf('const handleJumpToFirstFlagged');
    expect(start).toBeGreaterThan(-1);
    // Next top-level declaration after the callback (the P1-1 docs-tab ref).
    const endAnchor = review.indexOf('const didDefaultDocsTabRef', start);
    const block = review.slice(start, endAnchor === -1 ? start + 3000 : endAnchor);
    expect(block).toContain('SECTION_TO_TAB');
    expect(block).toContain('data-field-id=');
    expect(block).toContain('scrollIntoView');
    expect(block).toContain('.focus(');
    expect(block).toContain('setInteractedLowConfFields');
  });

  it('the inline sectionToTab duplicate map is gone (single source: SECTION_TO_TAB)', () => {
    expect(review).not.toContain('sectionToTab');
  });
});
