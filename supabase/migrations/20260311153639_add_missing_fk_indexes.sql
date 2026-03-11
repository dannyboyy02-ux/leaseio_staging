-- Add missing indexes on foreign key columns that had no covering index,
-- causing sequential scans on every workspace-scoped query.
--
-- leases.workspace_id: no index existed at all
-- lease_activity_log.user_id: no index existed at all
-- lease_approvers.approver_id: existing unique index had it as non-leading column
-- workspace_members.user_id: existing unique index had it as non-leading column

CREATE INDEX IF NOT EXISTS idx_leases_workspace_id
  ON public.leases (workspace_id);

CREATE INDEX IF NOT EXISTS idx_lease_activity_log_user_id
  ON public.lease_activity_log (user_id);

CREATE INDEX IF NOT EXISTS idx_lease_approvers_approver_id
  ON public.lease_approvers (approver_id);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
  ON public.workspace_members (user_id);
