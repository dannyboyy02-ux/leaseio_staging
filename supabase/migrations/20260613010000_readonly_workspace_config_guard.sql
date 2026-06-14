-- Read-only enforcement for workspace CONFIG columns (Vault V3 review HIGH;
-- VAULT_TIER_SPEC.md). Closes a gap that predates Vault: V1's read-only
-- layer (20260613000000) deliberately left the `workspaces` table out of the
-- restrictive-RLS loop (owner rename must stay open), and the #29 entitlement
-- guard only protects billing/entitlement columns. So a member of a non-live
-- workspace (canceled grace / soft-deleted / Vault) could still mutate report
-- and financial CONFIG columns via PostgREST — e.g. discount_rate and the
-- report_* settings surfaced on the Reports page, which V3 opened to Vault.
-- Worse, a discount_rate change triggers a client-side lease recompute whose
-- lease writes ARE gated (42501), leaving stored financials diverged from the
-- displayed rate on a tier sold as immutable.
--
-- Mechanism: a BEFORE UPDATE trigger mirroring the #29 guard's shape
-- (auth.role() service_role bypass; raise check_violation on a disallowed
-- change). It owns a column set DISJOINT from the #29 guard's billing set and
-- from `name` (owner rename stays open, per V1's documented carve-out), so
-- the two BEFORE-UPDATE triggers never contend on the same column regardless
-- of Postgres's alphabetical firing order (trigger-ordering rule).
--
-- "Non-live" matches public.is_workspace_live(): canceled_at set OR
-- soft_deleted_at set OR plan = 'vault'. Liveness is read from the OLD row
-- (the workspace's current state) — we block writes TO an already-non-live
-- workspace; the service-role conversion that SETS plan='vault' bypasses.
--
-- INSERT is not guarded here: creation-time config defaults are legitimate
-- and a brand-new workspace is always live. service_role (webhook, edge
-- functions) bypasses wholesale — it is the legitimate writer of conversions
-- and any admin operation.

CREATE OR REPLACE FUNCTION public.prevent_readonly_workspace_config_edits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Service role is the legitimate writer for conversions/admin ops.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Only restrict writes to a NON-LIVE workspace. A live workspace's config
  -- edits are governed by the existing role/RLS checks, not this guard.
  IF OLD.canceled_at IS NULL
     AND OLD.soft_deleted_at IS NULL
     AND COALESCE(OLD.plan, '') <> 'vault' THEN
    RETURN NEW;
  END IF;

  -- Non-live: the workspace's report/financial/intake CONFIG is frozen. This
  -- column set is the read-only-relevant config; it is intentionally disjoint
  -- from the #29 billing/entitlement guard and excludes `name` (rename stays
  -- open) and the trigger-managed updated_at. Keep this list in sync if new
  -- config columns are added to workspaces.
  IF (NEW.discount_rate                    IS DISTINCT FROM OLD.discount_rate
   OR NEW.report_organization_name         IS DISTINCT FROM OLD.report_organization_name
   OR NEW.report_fiscal_year_start_month   IS DISTINCT FROM OLD.report_fiscal_year_start_month
   OR NEW.report_rounding_precision        IS DISTINCT FROM OLD.report_rounding_precision
   OR NEW.report_artifact_retention_days   IS DISTINCT FROM OLD.report_artifact_retention_days
   OR NEW.report_default_discount_method   IS DISTINCT FROM OLD.report_default_discount_method
   OR NEW.timezone                         IS DISTINCT FROM OLD.timezone
   OR NEW.default_notification_days        IS DISTINCT FROM OLD.default_notification_days
   OR NEW.covenant_threshold               IS DISTINCT FROM OLD.covenant_threshold
   OR NEW.approval_threshold               IS DISTINCT FROM OLD.approval_threshold
   OR NEW.backdoor_enabled                 IS DISTINCT FROM OLD.backdoor_enabled
   OR NEW.asset_type_config                IS DISTINCT FROM OLD.asset_type_config
   OR NEW.department_options               IS DISTINCT FROM OLD.department_options
   OR NEW.region_options                   IS DISTINCT FROM OLD.region_options
   OR NEW.location_options                 IS DISTINCT FROM OLD.location_options
   OR NEW.building_options                 IS DISTINCT FROM OLD.building_options
   OR NEW.separation_of_duties_default     IS DISTINCT FROM OLD.separation_of_duties_default
   OR NEW.counter_signature_default_due_days IS DISTINCT FROM OLD.counter_signature_default_due_days
  ) THEN
    RAISE EXCEPTION 'workspace configuration is read-only while the workspace is canceled, soft-deleted, or on the Vault retention tier'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_readonly_workspace_config_edits() IS
  'Read-only config guard for non-live workspaces (canceled grace / soft-deleted / Vault). Blocks non-service-role UPDATEs to workspaces report/financial/intake CONFIG columns: discount_rate, report_organization_name, report_fiscal_year_start_month, report_rounding_precision, report_artifact_retention_days, report_default_discount_method, timezone, default_notification_days, covenant_threshold, approval_threshold, backdoor_enabled, asset_type_config, department_options, region_options, location_options, building_options, separation_of_duties_default, counter_signature_default_due_days. DISJOINT from the #29 entitlement guard (billing columns) and from name (owner rename stays open). This comment IS the column inventory for the next re-derivation (Vault V3, 2026-06-13).';

DROP TRIGGER IF EXISTS enforce_workspace_readonly_config_guard ON public.workspaces;
CREATE TRIGGER enforce_workspace_readonly_config_guard
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.prevent_readonly_workspace_config_edits();
