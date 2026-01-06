-- Create subscription_plan enum for 4-tier pricing
DO $$ BEGIN
  CREATE TYPE subscription_plan AS ENUM ('free', 'starter', 'pro', 'business');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add billing_interval column to workspaces
ALTER TABLE public.workspaces 
ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'monthly';

-- Migrate existing plan values: current 'pro' (3 docs) becomes 'starter', 'business' stays 'business'
UPDATE public.workspaces 
SET plan = 'starter' 
WHERE plan = 'pro';

-- Update document limits for the new tiers
-- Starter: 5 docs, Pro: 15 docs, Business: 50 docs
UPDATE public.workspaces 
SET document_limit = CASE 
  WHEN plan = 'starter' THEN 5
  WHEN plan = 'business' THEN 50
  ELSE 1  -- free tier
END;

-- Add billing_interval to profiles for user-level tracking
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS billing_interval text NOT NULL DEFAULT 'monthly';

-- Add trial tracking
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS trial_ends_at timestamp with time zone;