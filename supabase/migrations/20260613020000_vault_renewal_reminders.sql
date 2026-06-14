-- Vault renewal-reminder dedup ledger (VAULT_TIER_SPEC.md V4 — no-surprise-
-- billing rule). The vault-renewal-reminder cron emails a Vault workspace's
-- owner ~14 days before the annual $249 subscription renews. This ledger is
-- the idempotency gate: one reminder per (workspace, renewal period). The
-- UNIQUE (workspace_id, period_end) constraint makes a daily cron safe — the
-- first send claims the row; subsequent days in the 14-day window conflict and
-- skip. Next year's renewal carries a new period_end, so a new row is allowed.
--
-- Operator/system-only: RLS is enabled with NO policies, so only service_role
-- (the cron, which bypasses RLS) can read/write it. Clients have no access —
-- this is billing-operational data, never user-facing.

CREATE TABLE IF NOT EXISTS public.vault_renewal_reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period_end   timestamptz NOT NULL,
  recipients   text[] NOT NULL DEFAULT '{}',
  sent_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, period_end)
);

ALTER TABLE public.vault_renewal_reminders ENABLE ROW LEVEL SECURITY;

-- Helpful for the cron's "already reminded for this period?" lookup and for
-- ON DELETE CASCADE cleanup. The UNIQUE constraint already indexes
-- (workspace_id, period_end); this covers workspace_id-only scans.
CREATE INDEX IF NOT EXISTS idx_vault_renewal_reminders_workspace
  ON public.vault_renewal_reminders (workspace_id);

COMMENT ON TABLE public.vault_renewal_reminders IS
  'Idempotency ledger for the vault-renewal-reminder cron (one row per workspace per renewal period; UNIQUE workspace_id+period_end). service_role-only (RLS on, no policies). Vault V4, 2026-06-13.';
