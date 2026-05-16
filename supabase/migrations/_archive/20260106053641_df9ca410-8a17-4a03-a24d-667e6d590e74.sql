-- Create role enum for workspace members
CREATE TYPE public.workspace_role AS ENUM ('admin', 'editor', 'viewer');

-- Drop the old role column and add the new enum type
ALTER TABLE public.workspace_members 
  DROP COLUMN role,
  ADD COLUMN role workspace_role NOT NULL DEFAULT 'viewer';

-- Create security definer function to check workspace role (avoids RLS recursion)
CREATE OR REPLACE FUNCTION public.get_workspace_role(_workspace_id uuid, _user_id uuid)
RETURNS workspace_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.workspace_members
  WHERE workspace_id = _workspace_id
    AND user_id = _user_id
$$;

-- Function to check if user has at least a certain role level in workspace
CREATE OR REPLACE FUNCTION public.has_workspace_permission(_workspace_id uuid, _user_id uuid, _min_role workspace_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = _workspace_id
      AND user_id = _user_id
      AND (
        CASE role
          WHEN 'admin' THEN 3
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1
        END >= CASE _min_role
          WHEN 'admin' THEN 3
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1
        END
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$$;

-- Update is_workspace_member to work with new structure
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = _workspace_id
      AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$$;

-- Add workspace_id to leases table to support team access
ALTER TABLE public.leases 
  ADD COLUMN workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL;

-- Update lease RLS policies to support workspace access
DROP POLICY IF EXISTS "leases_select_own" ON public.leases;
CREATE POLICY "leases_select_own_or_workspace" ON public.leases
  FOR SELECT USING (
    user_id = auth.uid() 
    OR is_workspace_member(workspace_id, auth.uid())
  );

DROP POLICY IF EXISTS "leases_update_own" ON public.leases;
CREATE POLICY "leases_update_own_or_workspace_editor" ON public.leases
  FOR UPDATE USING (
    user_id = auth.uid() 
    OR has_workspace_permission(workspace_id, auth.uid(), 'editor')
  );

DROP POLICY IF EXISTS "leases_delete_own" ON public.leases;
CREATE POLICY "leases_delete_own_or_workspace_admin" ON public.leases
  FOR DELETE USING (
    user_id = auth.uid() 
    OR has_workspace_permission(workspace_id, auth.uid(), 'admin')
  );

-- Add invited_email column to workspace_members for pending invites
ALTER TABLE public.workspace_members
  ADD COLUMN invited_email text,
  ADD COLUMN invited_at timestamp with time zone,
  ADD COLUMN accepted_at timestamp with time zone;