-- ─────────────────────────────────────────────────────────────────────────
-- Widen billing_dead_letters' source↔reason matrix so a DOCUMENT PACK can also
-- be dead-lettered as 'unknown_workspace' (Codex PR #71 review).
--
-- WHY: applyDocumentPack runs `UPDATE workspaces SET addon_document_capacity
-- WHERE id = <metadata workspace_id>`. A 0-row PostgREST update is NOT an error,
-- so a pack whose metadata points at a deleted/unknown workspace was acked to
-- Stripe with no capacity change AND no dead-letter — the exact #65 silent-drop
-- class, but applyDocumentPack (unlike applySingleLeaseCredit) had no existence
-- guard, and the original matrix (20260622000000) disallowed 'unknown_workspace'
-- for source='document_pack', so even emitting it would have failed the CHECK.
-- This widening lets the webhook record that case. The widened matrix is a strict
-- SUPERSET of the old one, so every existing row still validates.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.billing_dead_letters
  DROP CONSTRAINT IF EXISTS billing_dead_letters_source_reason_valid;

ALTER TABLE public.billing_dead_letters
  ADD CONSTRAINT billing_dead_letters_source_reason_valid CHECK (
    (source = 'document_pack' AND reason IN ('missing_workspace_id', 'missing_customer', 'unknown_workspace'))
    OR (source = 'single_lease_credit' AND reason IN ('missing_workspace_id', 'unknown_workspace', 'underpaid', 'customer_mismatch'))
  );
