-- Cluster D (performance) — safe slice: covering indexes for unindexed foreign
-- keys + drop two duplicate indexes. (2026-06-23)
--
-- Source: Supabase performance advisor (lint 0001 unindexed_foreign_keys +
-- duplicate_index). This slice is PURELY additive/cleanup DDL — no RLS policy,
-- no trigger, no function, no column semantics change — so it carries no
-- authorization risk (distinct from the larger auth_rls_initplan / multiple-
-- permissive-policy remediation, which is security-sensitive and handled
-- separately with pre-apply security review).
--
-- All targeted tables are small (firm_*, ops_admins, vendor_alert_log,
-- classification_corrections, workspace_activity_log/creation_requests,
-- profiles), so a plain CREATE INDEX (brief ACCESS EXCLUSIVE lock) is fine and
-- keeps the statements transaction-safe under the migration runner. (CONCURRENTLY
-- can't run inside the runner's transaction and isn't warranted at this size.)
-- Idempotent: IF NOT EXISTS / IF EXISTS throughout, re-runnable.

-- ── 1. Covering indexes for the 13 advisor-flagged unindexed foreign keys ──────
-- Each indexes the FK column so cascade checks + joins on the referenced side
-- don't seq-scan the child table.

CREATE INDEX IF NOT EXISTS idx_classification_corrections_corrected_by
  ON public.classification_corrections (corrected_by);

CREATE INDEX IF NOT EXISTS idx_firm_activity_log_user_id
  ON public.firm_activity_log (user_id);

CREATE INDEX IF NOT EXISTS idx_firm_invitations_accepted_by
  ON public.firm_invitations (accepted_by);
CREATE INDEX IF NOT EXISTS idx_firm_invitations_invited_by
  ON public.firm_invitations (invited_by);
CREATE INDEX IF NOT EXISTS idx_firm_invitations_revoked_by
  ON public.firm_invitations (revoked_by);

CREATE INDEX IF NOT EXISTS idx_firm_members_created_by
  ON public.firm_members (created_by);

CREATE INDEX IF NOT EXISTS idx_firm_workspace_join_requests_acted_by
  ON public.firm_workspace_join_requests (acted_by);
CREATE INDEX IF NOT EXISTS idx_firm_workspace_join_requests_requested_by
  ON public.firm_workspace_join_requests (requested_by);

CREATE INDEX IF NOT EXISTS idx_ops_admins_added_by
  ON public.ops_admins (added_by);

CREATE INDEX IF NOT EXISTS idx_profiles_current_firm_id
  ON public.profiles (current_firm_id);

CREATE INDEX IF NOT EXISTS idx_vendor_alert_log_acknowledged_by
  ON public.vendor_alert_log (acknowledged_by);

CREATE INDEX IF NOT EXISTS idx_workspace_activity_log_user_id
  ON public.workspace_activity_log (user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_creation_requests_workspace_id
  ON public.workspace_creation_requests (workspace_id);

-- ── 2. Drop duplicate indexes (advisor lint duplicate_index) ───────────────────
-- Each pair is byte-identical (same table, same single column, same btree). Keep
-- the name that matches the table-prefixed convention; drop the older short name.
-- Both dropped names exist only in the squashed baseline + _archive (never
-- referenced by query logic — index names aren't used in SQL), so dropping the
-- redundant copy is safe and leaves the lease_id lookups fully covered.
DROP INDEX IF EXISTS public.idx_corrections_lease_id;       -- keep idx_field_corrections_lease_id
DROP INDEX IF EXISTS public.idx_field_confidence_lease_id;  -- keep idx_lease_field_confidence_lease_id
