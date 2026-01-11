-- Lease Lifecycle Workflow Migration (Business Plan Only)
-- Adds lease lifecycle states, approvers, activity logging, and nudge tracking

-- Add lifecycle workflow fields to leases table
ALTER TABLE public.leases 
ADD COLUMN IF NOT EXISTS lifecycle_status text DEFAULT 'draft' 
  CHECK (lifecycle_status IN ('draft', 'pending_internal_approval', 'lease_candidate', 'pending_execution_approval', 'active', 'rejected')),
ADD COLUMN IF NOT EXISTS category text CHECK (category IN ('property', 'equipment', 'vehicle', 'other')),
ADD COLUMN IF NOT EXISTS business_unit text,
ADD COLUMN IF NOT EXISTS estimated_term_min integer,
ADD COLUMN IF NOT EXISTS estimated_term_max integer,
ADD COLUMN IF NOT EXISTS estimated_monthly_cost_min numeric,
ADD COLUMN IF NOT EXISTS estimated_monthly_cost_max numeric,
ADD COLUMN IF NOT EXISTS lease_owner_id uuid REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS notes text,
ADD COLUMN IF NOT EXISTS rejection_reason text,
ADD COLUMN IF NOT EXISTS submitted_for_approval_at timestamptz,
ADD COLUMN IF NOT EXISTS internal_approved_at timestamptz,
ADD COLUMN IF NOT EXISTS execution_approved_at timestamptz,
ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- Create approvers table (workspace-scoped, not lease-scoped)
CREATE TABLE IF NOT EXISTS public.workspace_approvers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  UNIQUE(workspace_id, user_id)
);

-- Create lease approval actions table
CREATE TABLE IF NOT EXISTS public.lease_approval_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL REFERENCES auth.users(id),
  approval_type text NOT NULL CHECK (approval_type IN ('internal', 'execution')),
  action text NOT NULL CHECK (action IN ('approve', 'send_back', 'reject', 'pause')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Create lease approval assignments table (which approvers are assigned to a lease)
CREATE TABLE IF NOT EXISTS public.lease_approvers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL REFERENCES auth.users(id),
  approval_type text NOT NULL CHECK (approval_type IN ('internal', 'execution')),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lease_id, approver_id, approval_type)
);

-- Create activity log table (lightweight)
CREATE TABLE IF NOT EXISTS public.lease_activity_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  activity_type text NOT NULL CHECK (activity_type IN (
    'status_change', 'approval', 'rejection', 'send_back', 'pause',
    'nudge_sent', 'document_upload', 'created', 'comment'
  )),
  from_status text,
  to_status text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Create nudge tracking table
CREATE TABLE IF NOT EXISTS public.lease_nudges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  sent_by uuid REFERENCES auth.users(id),
  nudge_type text NOT NULL CHECK (nudge_type IN ('manual', 'automatic_day2', 'automatic_day5', 'automatic_day10')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms'))
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_leases_lifecycle_status ON public.leases(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_leases_lease_owner_id ON public.leases(lease_owner_id);
CREATE INDEX IF NOT EXISTS idx_lease_approval_actions_lease_id ON public.lease_approval_actions(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_approvers_lease_id ON public.lease_approvers(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_activity_log_lease_id ON public.lease_activity_log(lease_id);
CREATE INDEX IF NOT EXISTS idx_lease_nudges_lease_id ON public.lease_nudges(lease_id);
CREATE INDEX IF NOT EXISTS idx_workspace_approvers_workspace_id ON public.workspace_approvers(workspace_id);

-- Enable RLS on new tables
ALTER TABLE public.workspace_approvers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_approval_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_approvers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_nudges ENABLE ROW LEVEL SECURITY;

-- RLS Policies for workspace_approvers
CREATE POLICY "Workspace members can view approvers"
  ON public.workspace_approvers FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace owners can manage approvers"
  ON public.workspace_approvers FOR ALL
  USING (is_workspace_owner(workspace_id, auth.uid()));

-- RLS Policies for lease_approval_actions
CREATE POLICY "Users can view approval actions for their leases"
  ON public.lease_approval_actions FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lease_approval_actions.lease_id
    AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ));

CREATE POLICY "Approvers can create approval actions"
  ON public.lease_approval_actions FOR INSERT
  WITH CHECK (
    approver_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.lease_approvers la
      WHERE la.lease_id = lease_approval_actions.lease_id
      AND la.approver_id = auth.uid()
    )
  );

-- RLS Policies for lease_approvers
CREATE POLICY "Users can view lease approvers for their leases"
  ON public.lease_approvers FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lease_approvers.lease_id
    AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ));

CREATE POLICY "Lease owners and admins can assign approvers"
  ON public.lease_approvers FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lease_approvers.lease_id
    AND (l.user_id = auth.uid() OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'))
  ));

CREATE POLICY "Lease owners and admins can remove approvers"
  ON public.lease_approvers FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lease_approvers.lease_id
    AND (l.user_id = auth.uid() OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'))
  ));

-- RLS Policies for lease_activity_log
CREATE POLICY "Users can view activity for their leases"
  ON public.lease_activity_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lease_activity_log.lease_id
    AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ));

CREATE POLICY "Users can create activity entries"
  ON public.lease_activity_log FOR INSERT
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- RLS Policies for lease_nudges
CREATE POLICY "Users can view nudges for their leases"
  ON public.lease_nudges FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lease_nudges.lease_id
    AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ));

CREATE POLICY "Lease owners and admins can send nudges"
  ON public.lease_nudges FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.leases l
    WHERE l.id = lease_nudges.lease_id
    AND (l.user_id = auth.uid() OR l.lease_owner_id = auth.uid() OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'))
  ));