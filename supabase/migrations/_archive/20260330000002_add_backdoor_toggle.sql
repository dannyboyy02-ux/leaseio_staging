ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS backdoor_enabled boolean DEFAULT false;
COMMENT ON COLUMN workspaces.backdoor_enabled IS 'Admin toggle: when true, shows historical portfolio loader form for onboarding';
