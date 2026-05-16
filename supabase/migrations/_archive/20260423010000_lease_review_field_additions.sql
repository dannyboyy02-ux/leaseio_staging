-- Add new property fields to leases table
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS building TEXT,
  ADD COLUMN IF NOT EXISTS region TEXT;

-- Add unlock request fields to leases table
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS unlock_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unlock_requested_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS unlock_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS unlock_action_token text,
  ADD COLUMN IF NOT EXISTS unlock_token_expires_at timestamptz;

-- Add workspace asset type configuration
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS asset_type_config JSONB DEFAULT '["Real Estate", "Equipment", "Vehicle", "Other"]'::jsonb;

-- Drop the restrictive CHECK constraint on leases.asset_type so workspace-defined labels are allowed
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_asset_type_check;
