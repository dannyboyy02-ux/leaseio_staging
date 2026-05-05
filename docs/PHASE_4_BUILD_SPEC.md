# Phase 4 Build Spec — Negotiation Document Tracking

**Prerequisite reading:** `APPROVAL_ROUTING_ARCHITECTURE.md`, `PHASE_1_BUILD_SPEC.md`, `PHASE_2_BUILD_SPEC.md`, `PHASE_3_BUILD_SPEC.md`, `docs/PRODUCT_STRATEGY.md`
**Phase scope:** Track every document exchanged during the lease lifecycle — from concept-stage attachments through negotiation iterations to the fully executed contract. Surface the document history in the lease detail UI. Wire uploads into the existing lifecycle states without changing them.
**Out of scope for Phase 4:** Signator stage activation (Phase 5), pending counter-signature reminders (Phase 5), rerouting (Phase 6), delegation (Phase 7), report generation (Phase 8), firm layer (Phase 9+).

After Phase 3, the chain workflow correctly transitions a lease from `draft` → `concept_submitted` → `concept_under_review` → `in_negotiation`. But the `in_negotiation` state has no actual negotiation tracking — it's just a state name. Phase 4 makes that state useful by giving submitters and approvers a place to upload, version, annotate, and track every document that flows back and forth with the counterparty during negotiation.

---

## Goals of this phase

1. A new `lease_documents` table tracks every document exchanged for a lease, with version numbers, iteration numbers, type tags, and uploader identity.
2. A new storage bucket `lease-documents` holds the actual files with workspace-scoped RLS following the established pattern.
3. Submitters can upload concept attachments before/during the concept stage, and exchange documents during the `in_negotiation` stage with structured iteration tracking.
4. The lease detail UI surfaces a document history timeline showing every iteration, who uploaded what, and which document is the current latest.
5. The submitter can manually escalate back to a concept approver if material terms shifted during negotiation — that escalation is visible in the activity log and rolls the lifecycle back to `concept_under_review`.
6. The lifecycle status remains driven by chain step actions (Phase 2/3 logic). Phase 4 does not introduce new state transitions; it adds a parallel data layer that exists alongside the lifecycle.

---

## Why a separate table, not just more columns on `leases`

The existing `leases` table has `storage_path` (concept document) and `executed_document_url` / `executed_storage_path` (final document). That worked when a lease was assumed to have at most two documents. Phase 4's negotiation loop produces an unbounded number of documents per lease — a draft, a redline, a counter-redline, another counter-redline, an LOI, a final negotiated draft, etc. Modeling that as columns would require schema changes for every new document type and would not preserve the iteration history in a queryable form.

A separate `lease_documents` table with one row per document iteration is the correct shape. The existing `leases.storage_path` and `leases.executed_storage_path` are preserved for backward compatibility — Phase 4 does not migrate or remove them, and existing code paths that reference them continue to work. New code uses `lease_documents` exclusively.

---

## Database migrations

Create one migration file: `<timestamp>_phase4_lease_documents.sql`.

### `lease_documents` table

```sql
CREATE TABLE public.lease_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id            uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_type       text NOT NULL CHECK (document_type IN (
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
    'other'
  )),
  iteration_number    integer NOT NULL,
  version_number      integer NOT NULL,
  storage_path        text NOT NULL,
  filename            text NOT NULL,
  mime_type           text,
  file_size_bytes     bigint,
  uploaded_by         uuid NOT NULL REFERENCES auth.users(id),
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  notes               text,
  is_current_latest   boolean NOT NULL DEFAULT false,
  superseded_by       uuid REFERENCES public.lease_documents(id),
  superseded_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lease_documents_lease_chronological
  ON public.lease_documents(lease_id, iteration_number, version_number);

CREATE INDEX idx_lease_documents_workspace
  ON public.lease_documents(workspace_id);

CREATE UNIQUE INDEX idx_lease_documents_one_current_latest_per_lease
  ON public.lease_documents(lease_id)
  WHERE is_current_latest = true;
```

Notes on schema choices:

- `iteration_number` is the negotiation pass — pass 1, pass 2, pass 3. Increments when a new round of back-and-forth begins. Determined by application logic, not auto-incremented.
- `version_number` is the version within an iteration — sometimes a single iteration has multiple revisions (we sent draft v1, the counterparty redlined it, we sent draft v2 of our redline back). Auto-increments per (lease_id, iteration_number).
- `is_current_latest` is a denormalized flag enforced by the unique partial index. Exactly one row per lease has this set to true at any time. The flag points at the document the team should be looking at right now.
- `superseded_by` and `superseded_at` build the lineage. A document can be superseded by a later iteration without being deleted — this preserves the full negotiation history for audit.
- Document types include the full set from the architecture document plus a few practical additions (`amendment`, `side_letter`, `other`). The set covers Phase 4 needs and is forward-compatible with Phase 5's `our_signed` and `fully_executed_counterparty_returned` states.

### Storage bucket

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('lease-documents', 'lease-documents', false)
ON CONFLICT (id) DO NOTHING;
```

### Row Level Security

```sql
ALTER TABLE public.lease_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace members read documents"
  ON public.lease_documents FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

-- Submitters and admins can insert documents for leases they have access to
CREATE POLICY "submitters and admins write documents"
  ON public.lease_documents FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role IN ('admin', 'editor')
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    AND uploaded_by = auth.uid()
    AND lease_id IN (
      SELECT id FROM public.leases WHERE workspace_id = lease_documents.workspace_id
    )
  );

-- Only admins can update or delete (e.g., correcting metadata, removing accidents).
-- Editing storage_path or filename is forbidden via column-level checks in the trigger.
CREATE POLICY "admins manage documents"
  ON public.lease_documents FOR UPDATE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "admins delete documents"
  ON public.lease_documents FOR DELETE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
```

### Storage RLS policies for the new bucket

Following the established pattern from `executed-leases` and `leases-pdfs`:

```sql
-- Workspace members can upload to their workspace's leases
CREATE POLICY "workspace members upload to lease-documents"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'lease-documents'
    AND owner = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.lease_documents ld
      WHERE ld.storage_path = name
        AND (
          ld.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
          )
          OR ld.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
        )
    )
  );

-- Workspace members can read documents for leases in their workspaces
CREATE POLICY "workspace members read lease-documents"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'lease-documents'
    AND EXISTS (
      SELECT 1 FROM public.lease_documents ld
      WHERE ld.storage_path = name
        AND (
          ld.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
          )
          OR ld.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
        )
    )
  );

-- Admins can delete from the bucket
CREATE POLICY "admins delete from lease-documents"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'lease-documents'
    AND EXISTS (
      SELECT 1 FROM public.lease_documents ld
      WHERE ld.storage_path = name
        AND (
          ld.workspace_id IN (
            SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
          )
          OR ld.workspace_id IN (
            SELECT workspace_id FROM public.workspace_members
              WHERE user_id = auth.uid() AND role = 'admin'
          )
        )
    )
  );
```

### Trigger to maintain `is_current_latest` flag

A trigger that fires after insert and ensures only the newest document for a lease has `is_current_latest = true`. Older documents get the flag cleared and `superseded_by` populated.

```sql
CREATE OR REPLACE FUNCTION public.maintain_lease_document_latest_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The new row is the latest. Mark prior latest as superseded.
  UPDATE public.lease_documents
     SET is_current_latest = false,
         superseded_by = NEW.id,
         superseded_at = now()
   WHERE lease_id = NEW.lease_id
     AND id <> NEW.id
     AND is_current_latest = true;

  -- Mark the new row as latest
  UPDATE public.lease_documents
     SET is_current_latest = true
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER lease_documents_latest_flag
  AFTER INSERT ON public.lease_documents
  FOR EACH ROW EXECUTE FUNCTION public.maintain_lease_document_latest_flag();
```

The trigger sets `is_current_latest = true` on the new row after the insert, so the application doesn't need to set it. The application sets `is_current_latest = false` (default) on insert; the trigger flips it.

### Activity log additions

Extend the existing `lease_activity_log_activity_type_check` constraint:

```sql
-- Query the current constraint definition first via pg_get_constraintdef
-- and snapshot all existing values before extending. Standard practice.

ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- Legacy (preserve verbatim from current state)
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment',
    'executed_uploaded', 'executed_terms_extracted', 'model_locked',
    'unlock_requested', 'unlock_approved', 'unlock_rejected',
    'change_submitted', 'change_approved', 'change_rejected', 'change_canceled',
    -- Phase 2
    'chain_resolved', 'chain_step_approved', 'chain_step_rejected',
    'chain_step_sent_back', 'chain_stage_completed', 'chain_resolution_failed',
    -- Phase 3
    'concept_stage_entered', 'concept_stage_completed',
    'negotiation_stage_entered', 'final_review_stage_entered',
    'pending_counter_signature_started', 'fully_executed_recorded',
    -- Phase 4 additions
    'document_iteration_uploaded',
    'document_iteration_superseded',
    'negotiation_escalated_to_concept',
    'document_marked_final_negotiated',
    'document_lineage_corrected'
  ));
```

---

## Code changes

### New file: `src/lib/leaseDocuments.ts`

Pure helpers for document type semantics, iteration math, and validation. Node-importable for vitest.

```typescript
// Stay in sync with supabase/functions/_shared/lease_documents.ts.
// Both files contain identical pure logic.

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

// Determines the next iteration number based on existing documents and the new doc's type.
// A new iteration starts when the new document is a fresh draft or a counterparty redline
// (signaling "they sent back a new round"). Same-iteration revisions use the existing
// iteration number with a bumped version_number.
export function nextIterationNumber(
  existingDocs: { iteration_number: number; document_type: DocumentType }[],
  newType: DocumentType,
): number {
  if (existingDocs.length === 0) return 1;
  const maxIteration = Math.max(...existingDocs.map(d => d.iteration_number));
  const startsNewIteration: DocumentType[] = ['draft', 'counter_redline', 'amendment', 'side_letter'];
  return startsNewIteration.includes(newType) ? maxIteration + 1 : maxIteration;
}

// Determines next version_number within a given iteration.
export function nextVersionNumber(
  existingDocs: { iteration_number: number; version_number: number }[],
  iterationNumber: number,
): number {
  const sameIter = existingDocs.filter(d => d.iteration_number === iterationNumber);
  if (sameIter.length === 0) return 1;
  return Math.max(...sameIter.map(d => d.version_number)) + 1;
}

// Returns whether a document type is appropriate for the given lifecycle status.
// Used by the upload UI to filter the type dropdown contextually.
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
      return type === 'our_signed' || type === 'other';
    case 'fully_executed':
    case 'executed':
      return type === 'fully_executed_counterparty_returned' || type === 'amendment' || type === 'side_letter' || type === 'other';
    case 'active':
      return type === 'amendment' || type === 'side_letter' || type === 'other';
    default:
      return false;
  }
}

// Display label for a document type.
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
```

### Mirror file: `supabase/functions/_shared/lease_documents.ts`

Identical pure logic, Deno-style.

### New edge function: `upload-lease-document`

A thin wrapper that handles the workflow of inserting a `lease_documents` row after a successful storage upload. Frontend uploads the file directly to storage via the supabase-js client, then calls this edge function with metadata. The edge function:

1. Verifies the user has access to the lease.
2. Computes `iteration_number` and `version_number` using the helpers.
3. Inserts the `lease_documents` row.
4. Inserts a `document_iteration_uploaded` activity log entry.
5. If the lease is in `concept_submitted` or `concept_under_review` and a `concept_attachment` is uploaded, no lifecycle change.
6. If the lease is in `in_negotiation` and any negotiation document type is uploaded, no lifecycle change (negotiation documents don't move the lifecycle automatically — that's by design; the submitter explicitly advances).
7. If the lease is in `final_review` and `final_negotiated` is uploaded, no lifecycle change but the activity log captures it as `document_marked_final_negotiated`.

The edge function does not move the lifecycle. Lifecycle changes happen via chain step actions (Phase 2/3) or via the explicit advance/escalate actions described next.

### New edge function: `escalate-to-concept-approver`

When the submitter decides during negotiation that material terms have shifted enough to require concept approver re-validation, they trigger this. It:

1. Verifies the user is the submitter or an admin.
2. Verifies the lease is currently in `in_negotiation`.
3. Updates `leases.lifecycle_status` to `concept_under_review` per the Lifecycle Transition Convention (status_changed_at bumped, status_change activity log with both column shapes, routing_path = 'chain').
4. Inserts a `negotiation_escalated_to_concept` activity log entry with the submitter's reason text.
5. Reactivates the most recent `chain_approval_chain` rows at the concept stage by inserting fresh `pending` rows (the prior approved rows stay marked `approved`; the system creates a new round of pending steps for re-review).
6. Notifies the concept approvers that re-review is needed.

This is manual escalation, not policy-driven. Phase 6 will introduce policy-driven re-routing on attribute changes; Phase 4's escalation is a submitter-initiated action.

### New edge function: `advance-to-final-review`

When the submitter says "we're ready, send to signator," they trigger this. It:

1. Verifies the user is the submitter or an admin.
2. Verifies the lease is currently in `in_negotiation`.
3. Verifies that at least one document of type `final_negotiated` has been uploaded (the system requires evidence of a finalized document before moving to final review).
4. Updates `leases.lifecycle_status` to `final_review` per the Lifecycle Transition Convention.
5. Inserts a `final_review_stage_entered` activity log entry.
6. Notifies the signator (resolved from the chain — Phase 5 owns full signator activation; Phase 4 just creates the notification).

Phase 4 introduces this transition but does not consume the signator's action — Phase 5 will. The lease can sit in `final_review` and Phase 4 closes; Phase 5 wires up the actual signator approval flow.

### Frontend: lease detail page additions

Add a new section to the lease detail UI titled "Documents." It shows:

- A timeline of every document, ordered by `iteration_number` ascending then `version_number` ascending.
- Each row shows: iteration label (e.g., "Iteration 2 — Counterparty Redline v1"), document type, filename, uploader, upload timestamp, file size, notes, and a "Current latest" badge if applicable.
- A "Download" button per row.
- An "Upload Document" button at the top of the section (visible to submitters and admins) that opens an upload modal:
  - File picker
  - Document type dropdown filtered by `isDocumentTypeAllowed(type, currentLifecycleStatus)`
  - Notes field (optional)
  - Submit button
- For `in_negotiation` leases, two additional buttons next to "Upload Document":
  - "Escalate to Concept Approver" — opens a modal with a required reason text field, calls `escalate-to-concept-approver`
  - "Advance to Final Review" — disabled until at least one `final_negotiated` document exists; calls `advance-to-final-review`

The upload modal performs:
1. Direct upload to the `lease-documents` bucket via supabase-js storage client. The storage path follows the convention `{workspace_id}/{lease_id}/{uuid}_{filename}`.
2. After successful upload, calls the `upload-lease-document` edge function with metadata (lease_id, storage_path, document_type, filename, mime_type, file_size_bytes, notes).
3. On success, refreshes the document timeline.

### Frontend: dashboard and approvals page integrations

The merged inbox in `ApprovalQueue.tsx` should add a small indicator on chain step rows showing the current document iteration count for the lease ("3 documents exchanged" or similar). This is informational only — clicking still navigates to the lease detail page.

The dashboard's lease pipeline should show a documents-uploaded count per lease where applicable.

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- `lease_documents` table accepts every value of `document_type`.
- `is_current_latest` unique partial index prevents two documents being marked latest for the same lease.
- Storage bucket exists.
- RLS: workspace member can read; non-member cannot.
- RLS: submitter or admin can insert; viewer cannot.
- RLS: only admin can update or delete.
- Trigger: inserting a new document marks it latest and supersedes the prior latest.
- Trigger: superseded document has `superseded_by` and `superseded_at` populated.

### Pure logic (vitest)

- `nextIterationNumber` returns 1 when no docs exist.
- `nextIterationNumber` increments when a `draft`, `counter_redline`, `amendment`, or `side_letter` is uploaded.
- `nextIterationNumber` stays the same for revision types within an iteration.
- `nextVersionNumber` returns 1 for first doc in an iteration; increments otherwise.
- `isDocumentTypeAllowed` returns correct truth values for every (type, lifecycle_status) pair.
- `documentTypeLabel` returns non-empty label for every type.
- Identical behavior between Node and Deno copies.

### Edge function

`upload-lease-document`:
- User with access can upload, row created, activity logged.
- User without access gets 403.
- Concurrent uploads don't break the trigger.
- Iteration and version computed correctly across a sequence of mock uploads.

`escalate-to-concept-approver`:
- Lease in `in_negotiation` advances to `concept_under_review`.
- Activity log entry created with the reason.
- New chain rows inserted for the concept stage.
- Lease not in `in_negotiation` rejected with clear error.
- Non-submitter, non-admin rejected.

`advance-to-final-review`:
- Lease in `in_negotiation` with a `final_negotiated` doc advances to `final_review`.
- Lease in `in_negotiation` without a `final_negotiated` doc rejected.
- Activity log and signator notification fire.

### Frontend (vitest)

- Document timeline renders in correct order (iteration ascending, then version ascending).
- "Current latest" badge shows on exactly one document per lease.
- Upload modal filters document type dropdown by current lifecycle status.
- "Advance to Final Review" disabled until a `final_negotiated` doc exists.
- "Escalate to Concept Approver" modal requires a reason before submission.

---

## Out of scope for Phase 4 — explicit list

Do NOT build any of these in Phase 4. Each is owned by a later phase.

- Signator stage activation. The lease can enter `final_review` via `advance-to-final-review` but the signator's approve/reject UI and chain step consumption is Phase 5.
- `pending_counter_signature` workflow with reminders for chasing counter-execution. Phase 5.
- Auto-extraction or AI analysis of the negotiation documents. Phase 4 stores them as opaque files; future phases may add AI summarization of redlines.
- Diffing or change-tracking between iterations. Useful but a major UI surface; defer.
- Bulk upload, drag-and-drop multi-file upload, or document templates. v1 ships single-file upload.
- Document expiration, archival, or retention policies. Defer.
- Email integration to auto-ingest counterparty replies as new iterations. Defer.
- E-signature integration (DocuSign, Adobe Sign). Phase 5 may consider this for the `our_signed` step.
- Firm-layer cross-workspace document views. Phase 9+.

---

## Definition of done for Phase 4

1. Migration applied cleanly to staging. All migration and trigger tests pass. Mirror committed.
2. `src/lib/leaseDocuments.ts` and `supabase/functions/_shared/lease_documents.ts` exist with identical pure logic. All vitest tests pass.
3. Three edge functions deployed: `upload-lease-document`, `escalate-to-concept-approver`, `advance-to-final-review`. Source verified against committed code via `get_edge_function`.
4. Lease detail UI shows the documents section with timeline, upload modal, and (for `in_negotiation` leases) the escalate and advance buttons.
5. Manual smoke covering:
   - Submit a chain-driven lease, advance through concept stage to `in_negotiation`
   - Upload an `loi` document during concept stage (or `concept_attachment`)
   - In `in_negotiation`, upload a `draft` (iteration 1, version 1)
   - Upload a `redline` from us (iteration 1, version 2)
   - Upload a `counter_redline` (iteration 2, version 1)
   - Upload a `final_negotiated` (latest)
   - Use "Escalate to Concept Approver" once and verify lifecycle rolls back
   - Use "Advance to Final Review" once `final_negotiated` exists
   - Verify the lease reaches `final_review` (and stays there until Phase 5)
6. Activity log captures every document upload, the escalation, and the advance correctly.
7. RLS verified: a user from another workspace cannot read documents.
8. No regression in the existing test suite. Typecheck clean.
9. As-built notes appendix on this spec captures any deltas discovered during implementation.
10. Phase closeout commit body lists every commit, migration, edge function deployment, and test added.

---

## Notes for Claude Code

- Reuse the existing storage bucket pattern from `executed-leases` and `leases-pdfs` migrations. Don't invent a new pattern for `lease-documents`.
- The `is_current_latest` trigger is the single source of truth for "which document is the latest." Application code should never set or unset this flag directly — only the trigger does.
- Storage uploads happen client-side via supabase-js. The edge function only inserts the metadata row; it does not handle the file bytes. This avoids the edge function timeout issues that large lease documents would cause.
- Match the file size limit set in storage bucket configuration (likely 50MB based on existing patterns) and surface a clear error in the upload modal for files that exceed it.
- The negotiation escalation flow (`escalate-to-concept-approver`) creates new pending chain rows rather than modifying existing ones — preserving the prior approval history is the correct audit pattern. The chain history grows; nothing is destroyed.
- Reuse the same checkpoint cadence as Phase 3:
  - Checkpoint 1: Migration + types regen + audit (only if any consumer audit is needed; Phase 4 is mostly additive so the audit may be lightweight)
  - Checkpoint 2: Pure helpers + vitest
  - Checkpoint 3: Edge functions + smoke
  - Checkpoint 4: Frontend (timeline, upload modal, escalate/advance buttons)
  - Checkpoint 5: Tests + docs + closeout + manual end-to-end smoke
- Apply the Lifecycle Transition Convention from CLAUDE.md to every new transition trigger introduced (`escalate-to-concept-approver` and `advance-to-final-review`).
- Apply the Permissions Gating Convention from CLAUDE.md to every UI gate that controls document upload visibility.
- Apply the Schema Change Rule — every schema change goes into a `.sql` file in `supabase/migrations/`, no exceptions.
- Reference `docs/PRODUCT_STRATEGY.md` for any decision that touches tier boundaries. Phase 4 features are part of Pro tier (and inherited by Business via firm-aware RLS in Phase 9). Plus tier customers have access to a simplified subset that the existing storage_path / executed_storage_path columns serve.
- Do not introduce new dependencies. Stick to what is already in `package.json`.

---

## As-built notes (placeholder, populated at close)

Spec ↔ implementation deltas to be captured here at Checkpoint 5 close, citing this spec doc by SHA per the audit-doc inheritance rule.

---

## Tracking

Spec ratified 2026-05-05. Owner Workspace Management closed before this spec opened. Phase 5 (signator stage activation + counter-signature reminders) opens after this phase closes.
