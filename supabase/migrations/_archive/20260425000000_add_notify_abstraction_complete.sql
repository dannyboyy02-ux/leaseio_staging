ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS notify_abstraction_complete boolean NOT NULL DEFAULT true;
