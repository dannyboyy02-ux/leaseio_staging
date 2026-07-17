import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1-1 (END_TO_END_REVIEW / j3-requestor §1.5): a chain-routed request dead-ended
// at `in_negotiation` because the state shares the `post_concept_pre_signator`
// STATE_GROUP with legacy `approved`, so `isEquivalent(..,'approved')` was true and
// `isIntakeStage` captured it → LeaseReview early-returned the intake summary view,
// and the Phase 4 negotiation workbench (DocumentsPanel: upload iteration / send
// back / advance to final review) never rendered. Plus a document-type catch-22:
// advancing needs a `final_negotiated` doc, but the upload dropdown only offered
// that type at `final_review` (unreachable without it).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P1-1 — in_negotiation reaches the negotiation workbench', () => {
  const review = read('src/pages/app/LeaseReview.tsx');

  it('isIntakeStage explicitly excludes in_negotiation', () => {
    // The intake early-return must NOT capture in_negotiation, or the workbench
    // (and its DocumentsPanel) is unreachable in exactly that state.
    expect(review).toMatch(/isIntakeStage[\s\S]{0,200}lifecycleStatusTyped !== 'in_negotiation'/);
  });

  it('DocumentsPanel is still mounted in the main workbench render', () => {
    // The destination the exclusion routes to.
    expect(review).toContain('<DocumentsPanel');
  });
});

describe('P1-1 — the final_negotiated catch-22 is broken (both mirrors)', () => {
  for (const p of [
    'src/lib/leaseDocuments.ts',
    'supabase/functions/_shared/lease_documents.ts',
  ]) {
    it(`${p} allows final_negotiated during in_negotiation`, () => {
      const src = read(p);
      // Narrow to the in_negotiation/approved case block before asserting, so a
      // match in a different case (e.g. final_review) can't produce a false pass.
      const block = src.slice(
        src.indexOf("case 'in_negotiation'"),
        src.indexOf("case 'final_review'"),
      );
      expect(block).toContain('final_negotiated');
    });
  }
});
