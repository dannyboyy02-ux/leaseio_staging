-- ─────────────────────────────────────────────────────────────────────────
-- billing_dead_letters — durable, attributable record of any Stripe paid event
-- the webhook could NOT honor (#65).
--
-- WHY: stripe-webhook's applyDocumentPack / applySingleLeaseCredit return early
-- on a paid event they can't attribute or that fails a guard (missing
-- workspace_id, missing/unknown customer/workspace, underpaid, customer
-- mismatch). Previously these were a bare console.warn/console.error + 200 ack:
-- the customer's money moved but the grant silently vanished with no durable
-- trail. That brushes the "no silent vendor failures" hard rule. This table is
-- the dead-letter sink so every un-honored paid event is forensically
-- recoverable and surfaceable to ops.
--
-- ACCESS MODEL (mirrors the vendor_alert_log monitoring pattern):
--   - Writes: service-role ONLY (the stripe-webhook), which bypasses RLS. No
--     client INSERT/UPDATE/DELETE policy exists, so RLS denies all direct
--     client writes — the table is append-only from any client's perspective
--     and immutable once written (resolution is a future service-role reconcile
--     sweep, not a client UPDATE).
--   - Reads: ops admins only, via the existing SECURITY DEFINER is_ops_admin()
--     helper (forensic surface for the ops dashboard).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.billing_dead_letters (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which grant path dropped the event.
  source                text NOT NULL CHECK (source IN ('document_pack', 'single_lease_credit')),
  -- Why it was not honored.
  reason                text NOT NULL CHECK (reason IN (
                          'missing_workspace_id',
                          'missing_customer',
                          'unknown_workspace',
                          'underpaid',
                          'customer_mismatch'
                        )),
  -- Stripe identifiers for reconciliation. object_id is the subscription id
  -- (document_pack) or payment_intent id (single_lease_credit).
  stripe_event_id       text,
  stripe_object_id      text NOT NULL,
  stripe_customer_id    text,
  -- The workspace_id claimed in metadata, if any. TEXT not uuid: on the
  -- missing/garbage-metadata path the value may be absent or malformed, and the
  -- forensic record must capture exactly what arrived.
  claimed_workspace_id  text,
  amount_cents          integer,
  -- The user who paid (single_lease_credit path: mirrors the ledger's
  -- purchased_by — the "who paid and never got their credit"). Null on the
  -- document_pack path and whenever metadata is absent/malformed.
  purchased_by          uuid,
  raw_metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Recurrence signal: the webhook upserts on the dedupe triple and bumps these,
  -- so a one-off drop and a 40x-redelivered persistent failure are
  -- distinguishable. created_at / amount_cents / raw_metadata stay FROZEN at the
  -- authoritative first capture; only these two move.
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  attempt_count         integer NOT NULL DEFAULT 1,
  -- Set by a future service-role reconcile/ops close-out (not a client write).
  resolved_at           timestamptz,
  resolution_note       text,
  -- The reason must be valid for its source — self-policing against a future
  -- webhook miswiring. Pack drops are attribution-only; single-lease adds the
  -- charge-validation rejections (applyDocumentPack re-derives capacity wholesale
  -- so it has no underpaid/mismatch guard).
  CONSTRAINT billing_dead_letters_source_reason_valid CHECK (
    (source = 'document_pack' AND reason IN ('missing_workspace_id', 'missing_customer'))
    OR (source = 'single_lease_credit' AND reason IN ('missing_workspace_id', 'unknown_workspace', 'underpaid', 'customer_mismatch'))
  )
);

-- Idempotency: webhook retries of the same un-honored event must not pile up
-- duplicate rows. The webhook upserts on this triple, bumping last_seen_at +
-- attempt_count ON CONFLICT (the first capture stays authoritative/frozen).
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_dead_letters_dedupe
  ON public.billing_dead_letters (source, stripe_object_id, reason);

-- Ops dashboard: surface the open (unresolved) items newest-first.
CREATE INDEX IF NOT EXISTS idx_billing_dead_letters_unresolved
  ON public.billing_dead_letters (created_at DESC)
  WHERE resolved_at IS NULL;

-- Reconcile pivot: jump from a Stripe Dashboard event id to its dead-letter row.
CREATE INDEX IF NOT EXISTS idx_billing_dead_letters_event
  ON public.billing_dead_letters (stripe_event_id);

ALTER TABLE public.billing_dead_letters ENABLE ROW LEVEL SECURITY;
-- FORCE so RLS applies even to the table owner / owner-context SECURITY DEFINER
-- code: this is a forensic, immutable record and must not be bypassable by any
-- in-DB path other than the explicit service-role webhook write.
ALTER TABLE public.billing_dead_letters FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.billing_dead_letters IS
  'Forensic dead-letter sink for Stripe paid events the webhook could not honor (#65). Append-only + immutable by design: service-role (stripe-webhook) writes via RLS bypass, ops admins read via is_ops_admin. Do NOT add a client INSERT/UPDATE/DELETE policy — resolution is a future service-role reconcile sweep, never a client write.';

-- Reads: ops admins only. (Service-role writes bypass RLS; there is
-- deliberately NO client INSERT/UPDATE/DELETE policy, so the table is
-- append-only + immutable from every client.)
DROP POLICY IF EXISTS "ops admins read billing dead letters" ON public.billing_dead_letters;
CREATE POLICY "ops admins read billing dead letters"
  ON public.billing_dead_letters FOR SELECT
  TO authenticated
  USING (public.is_ops_admin(auth.uid()));
