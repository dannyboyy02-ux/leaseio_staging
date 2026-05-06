// ─────────────────────────────────────────────────────────────────────────
// Pure document-tracking helpers — Node mirror.
//
// SYNC CONSTRAINT — DO NOT DRIFT
// This file MUST stay byte-equivalent in *behavior* with its Deno
// counterpart:
//   supabase/functions/_shared/lease_documents.ts
//
// Both files contain identical pure functions and types. This Node copy
// is imported by the frontend (LeaseRequestForm-equivalent upload UI,
// lease detail page document timeline) and by vitest unit tests in
// src/lib/__tests__/leaseDocuments.test.ts. The Deno copy is imported
// by the Phase 4 edge functions (upload-lease-document,
// escalate-to-concept-approver, advance-to-final-review).
//
// When you change one, change the other in the same commit. No imports
// allowed in either file (no React, no Supabase, no Deno-only or
// Node-only modules) — only language-level types and logic.
//
// PHASE 4 SCOPE
// These helpers cover document-type semantics, iteration/version math,
// and lifecycle-vs-type compatibility. Storage upload itself happens
// client-side via supabase-js; the edge function only inserts the
// metadata row. See docs/PHASE_4_BUILD_SPEC.md for the full contract.
// ─────────────────────────────────────────────────────────────────────────

export type DocumentType =
  | 'concept_attachment'
  | 'loi'
  | 'draft'
  | 'redline'
  | 'counter_redline'
  | 'final_negotiated'
  | 'our_signed'
  | 'fully_executed_counterparty_returned'
  | 'amendment'
  | 'side_letter'
  | 'other';

export const ALL_DOCUMENT_TYPES: DocumentType[] = [
  'concept_attachment',
  'loi',
  'draft',
  'redline',
  'counter_redline',
  'final_negotiated',
  'our_signed',
  'fully_executed_counterparty_returned',
  'amendment',
  'side_letter',
  'other',
];

// Document types whose upload begins a NEW negotiation iteration
// (vs. continuing the current one with an incremented version_number).
//
// Rationale per the spec:
//   - 'draft'           — fresh round of back-and-forth begins
//   - 'counter_redline' — counterparty sent back a new round
//   - 'amendment'       — post-execution amendments are their own pass
//   - 'side_letter'     — same: a new negotiated artifact
//
// All other types continue the existing iteration with a bumped
// version_number (e.g. our_redline → counter_redline back → our redline
// → ... all of these are revisions inside the same pass until a new
// 'draft' or 'counter_redline' opens the next pass).
const ITERATION_STARTING_TYPES: DocumentType[] = [
  'draft',
  'counter_redline',
  'amendment',
  'side_letter',
];

/**
 * Returns the next iteration_number for a new document of the given
 * type, given the existing documents on the lease.
 *
 * - 1 when the lease has no documents yet
 * - max(existing) + 1 when newType begins a new iteration
 * - max(existing) when newType continues the current iteration
 */
export function nextIterationNumber(
  existingDocs: { iteration_number: number; document_type: DocumentType }[],
  newType: DocumentType,
): number {
  if (existingDocs.length === 0) return 1;
  const maxIteration = Math.max(...existingDocs.map((d) => d.iteration_number));
  return ITERATION_STARTING_TYPES.includes(newType) ? maxIteration + 1 : maxIteration;
}

/**
 * Returns the next version_number within the given iteration, given
 * the existing documents on the lease.
 *
 * - 1 when no documents in this iteration yet
 * - max(versions in this iteration) + 1 otherwise
 */
export function nextVersionNumber(
  existingDocs: { iteration_number: number; version_number: number }[],
  iterationNumber: number,
): number {
  const sameIter = existingDocs.filter((d) => d.iteration_number === iterationNumber);
  if (sameIter.length === 0) return 1;
  return Math.max(...sameIter.map((d) => d.version_number)) + 1;
}

/**
 * Returns whether a document type is appropriate for the given
 * lifecycle status. Used by the upload UI to filter the type
 * dropdown contextually so users see only the types that make sense
 * for the lease's current stage.
 *
 * Lifecycle values cover BOTH legacy and chain vocabularies (Phase 3)
 * — chain leases at concept_under_review and legacy leases at
 * under_review get the same options.
 *
 * Unknown lifecycle returns false (defensive — never offer types for
 * a state we don't know how to interpret).
 */
export function isDocumentTypeAllowed(
  type: DocumentType,
  lifecycleStatus: string,
): boolean {
  switch (lifecycleStatus) {
    case 'draft':
    case 'submitted':
    case 'concept_submitted':
    case 'concept_under_review':
    case 'under_review':
      return type === 'concept_attachment' || type === 'loi' || type === 'other';
    case 'in_negotiation':
    case 'approved': // legacy mapping for chain-mode equivalence
      return ['draft', 'redline', 'counter_redline', 'loi', 'other'].includes(type);
    case 'final_review':
      return type === 'final_negotiated' || type === 'other';
    case 'pending_counter_signature':
      // Phase 5: 'fully_executed_counterparty_returned' is the document
      // type record-counter-signature looks for to land the lease in
      // 'fully_executed'. Must be uploadable while the lease is still
      // in pending_counter_signature.
      return (
        type === 'our_signed' ||
        type === 'fully_executed_counterparty_returned' ||
        type === 'other'
      );
    case 'fully_executed':
    case 'executed':
      return (
        type === 'fully_executed_counterparty_returned' ||
        type === 'amendment' ||
        type === 'side_letter' ||
        type === 'other'
      );
    case 'active':
      return type === 'amendment' || type === 'side_letter' || type === 'other';
    default:
      return false;
  }
}

/**
 * Returns the allowed document types for a given lifecycle status,
 * filtered out of ALL_DOCUMENT_TYPES via isDocumentTypeAllowed.
 * Convenience wrapper for the upload UI's dropdown.
 */
export function allowedDocumentTypesFor(lifecycleStatus: string): DocumentType[] {
  return ALL_DOCUMENT_TYPES.filter((t) => isDocumentTypeAllowed(t, lifecycleStatus));
}

/**
 * Display label for a document type. Falls back to the raw value for
 * unknown types (defensive — production should never hit the fallback,
 * the type union is exhaustive).
 */
export function documentTypeLabel(type: DocumentType): string {
  const labels: Record<DocumentType, string> = {
    concept_attachment: 'Concept Attachment',
    loi: 'Letter of Intent',
    draft: 'Draft',
    redline: 'Redline',
    counter_redline: 'Counterparty Redline',
    final_negotiated: 'Final Negotiated',
    our_signed: 'Signed (Our Side)',
    fully_executed_counterparty_returned: 'Fully Executed',
    amendment: 'Amendment',
    side_letter: 'Side Letter',
    other: 'Other',
  };
  return labels[type] ?? type;
}
