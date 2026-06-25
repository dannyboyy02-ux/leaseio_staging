-- Leases redesign Phase 2b: workspace-configurable asset-type abbreviations
-- (the tight RE / EQP / VEH / CX shorthands shown on the Leases table).
--
-- A jsonb map keyed by the asset_type_config LABEL -> abbreviation, e.g.
-- { "Real Estate": "RE", "Customer": "CX" }. The client normalizes the key
-- (src/lib/assetTypes.ts normalizeAssetKey) so a snake_case lease.asset_type
-- ('real_estate') still matches a label-keyed entry. Client-validated only
-- (short, uppercased) — no DB CHECK, consistent with the other *_options config.
--
-- SECURITY NOTE: this re-creates the read-only CONFIG guard
-- (prevent_readonly_workspace_config_edits) to add the new column to its frozen
-- set, so a non-live workspace (canceled grace / soft-deleted / Vault) cannot
-- mutate it — same treatment asset_type_config already gets. The column is
-- DISJOINT from the #29 entitlement-guard set and from `name`, so trigger
-- ordering is unaffected. Route through the security-migration review BEFORE
-- applying (CLAUDE.md).

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS asset_type_abbreviations jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.workspaces.asset_type_abbreviations IS
  'Per-workspace asset-type display shorthands. jsonb map { "<asset_type_config label>": "<abbr>" } (e.g. {"Real Estate":"RE"}). Workspace CONFIG — frozen for non-live workspaces by prevent_readonly_workspace_config_edits. Client-validated only (short/uppercase); no value CHECK.';

-- Extend the read-only config guard to cover the new column. Re-create the
-- function in place; the trigger (enforce_workspace_readonly_config_guard) that
-- calls it is unchanged. Adds ONE line to the IS DISTINCT FROM set and keeps the
-- COMMENT inventory in sync, per that function's own maintenance note.
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

  -- Only restrict writes to a NON-LIVE workspace.
  IF OLD.canceled_at IS NULL
     AND OLD.soft_deleted_at IS NULL
     AND COALESCE(OLD.plan, '') <> 'vault' THEN
    RETURN NEW;
  END IF;

  -- Non-live: report/financial/intake CONFIG is frozen. Disjoint from the #29
  -- billing/entitlement guard and from `name` (rename stays open).
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
   OR NEW.asset_type_abbreviations         IS DISTINCT FROM OLD.asset_type_abbreviations
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
  'Read-only config guard for non-live workspaces (canceled grace / soft-deleted / Vault). Blocks non-service-role UPDATEs to workspaces report/financial/intake CONFIG columns: discount_rate, report_organization_name, report_fiscal_year_start_month, report_rounding_precision, report_artifact_retention_days, report_default_discount_method, timezone, default_notification_days, covenant_threshold, approval_threshold, backdoor_enabled, asset_type_config, asset_type_abbreviations, department_options, region_options, location_options, building_options, separation_of_duties_default, counter_signature_default_due_days. DISJOINT from the #29 entitlement guard (billing columns) and from name (owner rename stays open). Inventory updated 2026-06-25 (asset_type_abbreviations — Leases redesign Phase 2b).';
