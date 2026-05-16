-- Module: Operational Monitoring — Phase 3
--
-- Per-workspace quota snapshots. Same shape as vendor_usage_snapshots
-- but partitioned by workspace_id, with tier referring to the
-- workspace's plan (not a vendor tier). Powers the customer-facing
-- QuotaWarningBanner and the workspace_quota_snapshots cron pass in
-- vendor-health-check.
--
-- RLS: workspace members read their own workspace's snapshots
-- (mirrors the existing is_workspace_member pattern). Service-role
-- writes; no direct client INSERT/UPDATE/DELETE.

CREATE TABLE IF NOT EXISTS public.workspace_quota_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  metric          text NOT NULL,
  current_value   numeric NOT NULL,
  limit_value     numeric,
  pct_of_limit    numeric,
  tier            text,
  category        text NOT NULL CHECK (category IN ('soft_quota', 'hard_cliff', 'cost_runaway')),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_workspace_quota_recent
  ON public.workspace_quota_snapshots (workspace_id, metric, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_quota_global
  ON public.workspace_quota_snapshots (recorded_at DESC);

ALTER TABLE public.workspace_quota_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace members read their quotas" ON public.workspace_quota_snapshots;
CREATE POLICY "workspace members read their quotas"
  ON public.workspace_quota_snapshots FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Service-role-only writes; no client INSERT/UPDATE/DELETE policies.
