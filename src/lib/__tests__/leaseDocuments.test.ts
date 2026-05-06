import { describe, it, expect } from 'vitest';
import {
  ALL_DOCUMENT_TYPES,
  allowedDocumentTypesFor,
  documentTypeLabel,
  isDocumentTypeAllowed,
  nextIterationNumber,
  nextVersionNumber,
  type DocumentType,
} from '../leaseDocuments';

// ─── nextIterationNumber ────────────────────────────────────────────────

describe('nextIterationNumber', () => {
  it('returns 1 when there are no existing documents', () => {
    for (const type of ALL_DOCUMENT_TYPES) {
      expect(nextIterationNumber([], type)).toBe(1);
    }
  });

  it('increments when newType begins a new iteration (draft / counter_redline / amendment / side_letter)', () => {
    const existing = [
      { iteration_number: 1, document_type: 'draft' as DocumentType },
      { iteration_number: 1, document_type: 'redline' as DocumentType },
    ];
    expect(nextIterationNumber(existing, 'draft')).toBe(2);
    expect(nextIterationNumber(existing, 'counter_redline')).toBe(2);
    expect(nextIterationNumber(existing, 'amendment')).toBe(2);
    expect(nextIterationNumber(existing, 'side_letter')).toBe(2);
  });

  it('stays in the current iteration for revision-style types (redline / loi / final_negotiated / our_signed / fully_executed_counterparty_returned / concept_attachment / other)', () => {
    const existing = [
      { iteration_number: 1, document_type: 'draft' as DocumentType },
    ];
    expect(nextIterationNumber(existing, 'redline')).toBe(1);
    expect(nextIterationNumber(existing, 'loi')).toBe(1);
    expect(nextIterationNumber(existing, 'final_negotiated')).toBe(1);
    expect(nextIterationNumber(existing, 'our_signed')).toBe(1);
    expect(nextIterationNumber(existing, 'fully_executed_counterparty_returned')).toBe(1);
    expect(nextIterationNumber(existing, 'concept_attachment')).toBe(1);
    expect(nextIterationNumber(existing, 'other')).toBe(1);
  });

  it('honors the highest existing iteration even when iterations are non-contiguous', () => {
    // A pathological input shape — should not happen in practice but the
    // helper must not silently misbehave.
    const existing = [
      { iteration_number: 1, document_type: 'draft' as DocumentType },
      { iteration_number: 5, document_type: 'counter_redline' as DocumentType },
    ];
    expect(nextIterationNumber(existing, 'draft')).toBe(6);
    expect(nextIterationNumber(existing, 'redline')).toBe(5);
  });

  it('walks a realistic negotiation sequence correctly', () => {
    // Iteration 1: we send a draft → counterparty redlines → we counter
    //   doc 1: draft           (iter 1, ver 1) — opens iter 1
    //   doc 2: redline (ours)  (iter 1, ver 2) — same iter, new version
    // Iteration 2: counterparty sends back their counter
    //   doc 3: counter_redline (iter 2, ver 1) — opens iter 2
    //   doc 4: redline (ours)  (iter 2, ver 2) — same iter, new version
    // Iteration 3: we mark final
    //   doc 5: final_negotiated (iter 2, ver 3) — same iter, revision
    const docs: { iteration_number: number; document_type: DocumentType }[] = [];

    docs.push({ iteration_number: nextIterationNumber(docs, 'draft'), document_type: 'draft' });
    expect(docs[0].iteration_number).toBe(1);

    docs.push({ iteration_number: nextIterationNumber(docs, 'redline'), document_type: 'redline' });
    expect(docs[1].iteration_number).toBe(1);

    docs.push({ iteration_number: nextIterationNumber(docs, 'counter_redline'), document_type: 'counter_redline' });
    expect(docs[2].iteration_number).toBe(2);

    docs.push({ iteration_number: nextIterationNumber(docs, 'redline'), document_type: 'redline' });
    expect(docs[3].iteration_number).toBe(2);

    docs.push({ iteration_number: nextIterationNumber(docs, 'final_negotiated'), document_type: 'final_negotiated' });
    expect(docs[4].iteration_number).toBe(2);
  });
});

// ─── nextVersionNumber ──────────────────────────────────────────────────

describe('nextVersionNumber', () => {
  it('returns 1 for the first document in an iteration', () => {
    expect(nextVersionNumber([], 1)).toBe(1);
    expect(
      nextVersionNumber(
        [{ iteration_number: 1, version_number: 5 }],
        2,
      ),
    ).toBe(1);
  });

  it('increments past the max version in the same iteration', () => {
    const existing = [
      { iteration_number: 1, version_number: 1 },
      { iteration_number: 1, version_number: 2 },
      { iteration_number: 2, version_number: 1 },
    ];
    expect(nextVersionNumber(existing, 1)).toBe(3);
    expect(nextVersionNumber(existing, 2)).toBe(2);
    expect(nextVersionNumber(existing, 3)).toBe(1);
  });

  it('does not blend across iterations', () => {
    // Iter 1 has v1, v2, v3. Iter 2 has v1. The v3 in iter 1 must NOT
    // bump iter 2's next version to 4.
    const existing = [
      { iteration_number: 1, version_number: 1 },
      { iteration_number: 1, version_number: 2 },
      { iteration_number: 1, version_number: 3 },
      { iteration_number: 2, version_number: 1 },
    ];
    expect(nextVersionNumber(existing, 2)).toBe(2);
  });
});

// ─── isDocumentTypeAllowed — full truth table ───────────────────────────

describe('isDocumentTypeAllowed', () => {
  it('pre-submission states allow concept_attachment, loi, other only', () => {
    const preSubmissionStates = ['draft', 'submitted', 'concept_submitted', 'concept_under_review', 'under_review'];
    for (const state of preSubmissionStates) {
      expect(isDocumentTypeAllowed('concept_attachment', state)).toBe(true);
      expect(isDocumentTypeAllowed('loi', state)).toBe(true);
      expect(isDocumentTypeAllowed('other', state)).toBe(true);
      // Negative cases for this group
      expect(isDocumentTypeAllowed('draft', state)).toBe(false);
      expect(isDocumentTypeAllowed('redline', state)).toBe(false);
      expect(isDocumentTypeAllowed('counter_redline', state)).toBe(false);
      expect(isDocumentTypeAllowed('final_negotiated', state)).toBe(false);
      expect(isDocumentTypeAllowed('our_signed', state)).toBe(false);
      expect(isDocumentTypeAllowed('fully_executed_counterparty_returned', state)).toBe(false);
      expect(isDocumentTypeAllowed('amendment', state)).toBe(false);
      expect(isDocumentTypeAllowed('side_letter', state)).toBe(false);
    }
  });

  it('in_negotiation (and legacy "approved" equivalent) allow draft / redline / counter_redline / loi / other', () => {
    const negotiationStates = ['in_negotiation', 'approved'];
    for (const state of negotiationStates) {
      expect(isDocumentTypeAllowed('draft', state)).toBe(true);
      expect(isDocumentTypeAllowed('redline', state)).toBe(true);
      expect(isDocumentTypeAllowed('counter_redline', state)).toBe(true);
      expect(isDocumentTypeAllowed('loi', state)).toBe(true);
      expect(isDocumentTypeAllowed('other', state)).toBe(true);
      // Negative cases
      expect(isDocumentTypeAllowed('concept_attachment', state)).toBe(false);
      expect(isDocumentTypeAllowed('final_negotiated', state)).toBe(false);
      expect(isDocumentTypeAllowed('our_signed', state)).toBe(false);
      expect(isDocumentTypeAllowed('fully_executed_counterparty_returned', state)).toBe(false);
      expect(isDocumentTypeAllowed('amendment', state)).toBe(false);
      expect(isDocumentTypeAllowed('side_letter', state)).toBe(false);
    }
  });

  it('final_review allows final_negotiated and other only', () => {
    expect(isDocumentTypeAllowed('final_negotiated', 'final_review')).toBe(true);
    expect(isDocumentTypeAllowed('other', 'final_review')).toBe(true);
    expect(isDocumentTypeAllowed('draft', 'final_review')).toBe(false);
    expect(isDocumentTypeAllowed('our_signed', 'final_review')).toBe(false);
    expect(isDocumentTypeAllowed('amendment', 'final_review')).toBe(false);
  });

  it('pending_counter_signature allows our_signed, fully_executed_counterparty_returned, and other', () => {
    expect(isDocumentTypeAllowed('our_signed', 'pending_counter_signature')).toBe(true);
    expect(isDocumentTypeAllowed('other', 'pending_counter_signature')).toBe(true);
    // Phase 5: counter-signed doc must be uploadable while still pending
    // so record-counter-signature has the row to satisfy its precondition.
    expect(
      isDocumentTypeAllowed('fully_executed_counterparty_returned', 'pending_counter_signature'),
    ).toBe(true);
    expect(isDocumentTypeAllowed('final_negotiated', 'pending_counter_signature')).toBe(false);
    expect(isDocumentTypeAllowed('draft', 'pending_counter_signature')).toBe(false);
  });

  it('fully_executed and legacy executed allow fully_executed_counterparty_returned, amendment, side_letter, other', () => {
    for (const state of ['fully_executed', 'executed']) {
      expect(isDocumentTypeAllowed('fully_executed_counterparty_returned', state)).toBe(true);
      expect(isDocumentTypeAllowed('amendment', state)).toBe(true);
      expect(isDocumentTypeAllowed('side_letter', state)).toBe(true);
      expect(isDocumentTypeAllowed('other', state)).toBe(true);
      expect(isDocumentTypeAllowed('draft', state)).toBe(false);
      expect(isDocumentTypeAllowed('our_signed', state)).toBe(false);
    }
  });

  it('active allows amendment, side_letter, other only', () => {
    expect(isDocumentTypeAllowed('amendment', 'active')).toBe(true);
    expect(isDocumentTypeAllowed('side_letter', 'active')).toBe(true);
    expect(isDocumentTypeAllowed('other', 'active')).toBe(true);
    expect(isDocumentTypeAllowed('draft', 'active')).toBe(false);
    expect(isDocumentTypeAllowed('fully_executed_counterparty_returned', 'active')).toBe(false);
  });

  it('terminal-negative states (rejected, cancelled) allow nothing', () => {
    for (const state of ['rejected', 'cancelled']) {
      for (const type of ALL_DOCUMENT_TYPES) {
        expect(isDocumentTypeAllowed(type, state)).toBe(false);
      }
    }
  });

  it('unknown lifecycle status returns false for every type (defensive)', () => {
    for (const state of ['', 'made_up', 'CONCEPT_SUBMITTED', 'unknown']) {
      for (const type of ALL_DOCUMENT_TYPES) {
        expect(isDocumentTypeAllowed(type, state)).toBe(false);
      }
    }
  });
});

// ─── allowedDocumentTypesFor ────────────────────────────────────────────

describe('allowedDocumentTypesFor', () => {
  it('returns the same set as filtering ALL_DOCUMENT_TYPES through isDocumentTypeAllowed', () => {
    for (const state of [
      'draft', 'submitted', 'concept_submitted', 'concept_under_review',
      'under_review', 'in_negotiation', 'approved', 'final_review',
      'pending_counter_signature', 'fully_executed', 'executed', 'active',
      'rejected', 'cancelled', 'unknown',
    ]) {
      const fromHelper = allowedDocumentTypesFor(state);
      const fromFilter = ALL_DOCUMENT_TYPES.filter((t) => isDocumentTypeAllowed(t, state));
      expect(fromHelper).toEqual(fromFilter);
    }
  });

  it('returns a non-empty list for every active stage', () => {
    for (const state of [
      'draft', 'submitted', 'concept_submitted', 'concept_under_review',
      'under_review', 'in_negotiation', 'approved', 'final_review',
      'pending_counter_signature', 'fully_executed', 'executed', 'active',
    ]) {
      expect(allowedDocumentTypesFor(state).length).toBeGreaterThan(0);
    }
  });

  it('returns an empty list for terminal-negative + unknown states', () => {
    for (const state of ['rejected', 'cancelled', 'unknown', '', 'CONCEPT_SUBMITTED']) {
      expect(allowedDocumentTypesFor(state)).toEqual([]);
    }
  });
});

// ─── documentTypeLabel ──────────────────────────────────────────────────

describe('documentTypeLabel', () => {
  it('returns a non-empty user-facing label for every known type', () => {
    for (const type of ALL_DOCUMENT_TYPES) {
      const label = documentTypeLabel(type);
      expect(label).toBeTypeOf('string');
      expect(label.length).toBeGreaterThan(0);
      // Defensive: shouldn't return the raw enum string for known types
      expect(label).not.toBe(type);
    }
  });

  it('returns the spec-defined labels exactly', () => {
    expect(documentTypeLabel('concept_attachment')).toBe('Concept Attachment');
    expect(documentTypeLabel('loi')).toBe('Letter of Intent');
    expect(documentTypeLabel('draft')).toBe('Draft');
    expect(documentTypeLabel('redline')).toBe('Redline');
    expect(documentTypeLabel('counter_redline')).toBe('Counterparty Redline');
    expect(documentTypeLabel('final_negotiated')).toBe('Final Negotiated');
    expect(documentTypeLabel('our_signed')).toBe('Signed (Our Side)');
    expect(documentTypeLabel('fully_executed_counterparty_returned')).toBe('Fully Executed');
    expect(documentTypeLabel('amendment')).toBe('Amendment');
    expect(documentTypeLabel('side_letter')).toBe('Side Letter');
    expect(documentTypeLabel('other')).toBe('Other');
  });

  it('falls back to the raw value for unknown types (defensive)', () => {
    expect(documentTypeLabel('made_up_type' as DocumentType)).toBe('made_up_type');
  });
});

// ─── ALL_DOCUMENT_TYPES coverage ────────────────────────────────────────

describe('ALL_DOCUMENT_TYPES', () => {
  it('contains exactly 11 entries (the spec-defined CHECK constraint values)', () => {
    expect(ALL_DOCUMENT_TYPES).toHaveLength(11);
  });

  it('has no duplicates', () => {
    const seen = new Set(ALL_DOCUMENT_TYPES);
    expect(seen.size).toBe(ALL_DOCUMENT_TYPES.length);
  });
});
