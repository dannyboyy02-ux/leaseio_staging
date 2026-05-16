-- Phase 2: Approval Roles & Approval Chain

-- ─── workspace_roles ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspace_roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('submitter', 'manager_approver', 'financial_approver', 'admin')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, user_id, role)
);

ALTER TABLE public.workspace_roles ENABLE ROW LEVEL SECURITY;

-- Workspace members can read roles within their workspace
CREATE POLICY "workspace_roles_select" ON public.workspace_roles
  FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

-- Only admins (workspace owner or workspace_members.role = 'admin') can insert/update/delete
CREATE POLICY "workspace_roles_insert" ON public.workspace_roles
  FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "workspace_roles_update" ON public.workspace_roles
  FOR UPDATE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "workspace_roles_delete" ON public.workspace_roles
  FOR DELETE
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ─── leases — approval chain columns ───────────────────────────────────────
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS manager_approved_by        UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS manager_approved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS manager_rejection_reason   TEXT,

  ADD COLUMN IF NOT EXISTS financial_approved_by      UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS financial_approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS financial_rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS financial_returned_to_submitter BOOLEAN DEFAULT FALSE,

  ADD COLUMN IF NOT EXISTS lease_classification_set_by  UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS lease_classification_set_at  TIMESTAMPTZ;

-- Allow submitted → rejected (manager rejects) and under_review → submitted (financial returns)
-- These new transitions are handled at the application layer; no constraint change needed
-- since lifecycle_status constraint only validates allowed values, not transition sequences.
