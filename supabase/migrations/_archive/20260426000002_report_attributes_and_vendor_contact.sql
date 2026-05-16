-- ============================================================================
-- Report Attributes & Vendor Contact Fields
-- ============================================================================
-- Adds workspace-configurable option lists for Report Attribute dropdowns
-- (department, region, location, building) and vendor/counterparty contact
-- columns on the leases table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Workspace option lists for Report Attribute comboboxes
--    Each is an ordered JSON array of strings managed in Workspace Settings.
-- ----------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS department_options JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS region_options     JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS location_options   JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS building_options   JSONB NOT NULL DEFAULT '[]';

-- ----------------------------------------------------------------------------
-- 2. Vendor / Counterparty contact fields on leases
-- ----------------------------------------------------------------------------
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS vendor_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS vendor_address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS vendor_city          TEXT,
  ADD COLUMN IF NOT EXISTS vendor_state         TEXT,
  ADD COLUMN IF NOT EXISTS vendor_zip           TEXT,
  ADD COLUMN IF NOT EXISTS vendor_phone         TEXT;
