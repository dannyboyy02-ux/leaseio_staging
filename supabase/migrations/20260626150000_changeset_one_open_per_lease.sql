-- Concurrency guard for the lease change-set / unlock flow (KNOWN_ISSUES #158).
--
-- The governance model intends EXACTLY ONE open change set per lease at a time:
-- createDraftChangeSet() reuses an existing draft|pending_approval set instead
-- of creating a second, and model_locked serializes who may unlock. But that
-- reuse was a read-then-insert with NO database guard, so two concurrent
-- unlocks could each read "none exists" and both insert -> two open change sets
-- for one lease. The frontend resolves "the lease's open change set" expecting
-- exactly one, so two would non-deterministically surface different drafts to
-- different viewers (and historically could disable editing for the lease).
--
-- This partial unique index makes "one open change set per lease" a database
-- invariant. The edge function (lease-governance-action.createDraftChangeSet)
-- catches the 23505 the losing concurrent insert now receives and re-selects
-- the winner, so the race resolves to a single shared change set rather than an
-- error. (Gap 2 — unlocking while a set is already pending_approval — is closed
-- separately by a 409 guard in direct_unlock / approve_unlock_request.)
--
-- No data dedupe in this migration ON PURPOSE: prevent_change_set_field_tampering
-- blocks `status` writes from any non-service_role caller, INCLUDING the
-- migration / direct-DB role (the trigger comment states this is intended). A
-- 'canceled' dedupe UPDATE would therefore be rejected here. Verified zero
-- duplicate open change sets on staging before applying (2026-06-26). If a
-- future environment ever has duplicates, resolve them through the service-role
-- governance function (cancel the stale draft) before this index can build.

CREATE UNIQUE INDEX IF NOT EXISTS lease_change_sets_one_open_per_lease
  ON public.lease_change_sets (lease_id)
  WHERE status IN ('draft', 'pending_approval');
