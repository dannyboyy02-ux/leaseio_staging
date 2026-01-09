-- Add square_footage column to leases table
ALTER TABLE public.leases
ADD COLUMN square_footage integer;

-- Make user_id nullable in workspace_members for pending invites
ALTER TABLE public.workspace_members
ALTER COLUMN user_id DROP NOT NULL;