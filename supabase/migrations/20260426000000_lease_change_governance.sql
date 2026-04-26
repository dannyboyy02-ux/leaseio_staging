-- ============================================================================
-- Locked Lease Change Governance — Phase 1 Schema
-- ============================================================================
-- Adds three governance tables for the unlock-request → staged-edit →
-- change-approval workflow on model_locked active leases.
--
-- lifecycle_status is NOT modified — it stays 'active' throughout the entire
-- unlock/change cycle. Governance state is derived from these new tables.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. lease_unlock_requests
--    One row per admin-reviewed unlock request.
-- ----------------------------------------------------------------------------
CREATE TABLE public.lease_unlock_requests (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id           uuid        NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id       uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  requested_by       uuid        NOT NULL REFERENCES auth.users(id),
  request_reason     text        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'approved', 'rejected', 'canceled')),
  reviewed_by        uuid        REFERENCES auth.users(id),
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Keep updated_at current automatically
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER lease_unlock_requests_updated_at
  BEFORE UPDATE ON public.lease_unlock_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. lease_change_sets
--    One batch of proposed field changes per unlock cycle.
-- ----------------------------------------------------------------------------
CREATE TABLE public.lease_change_sets (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id            uuid        NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id        uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  unlock_request_id   uuid        REFERENCES public.lease_unlock_requests(id),
  submitted_by        uuid        NOT NULL REFERENCES auth.users(id),
  status              text        NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'canceled')),
  change_summary      text,
  submitted_at        timestamptz,
  reviewed_by         uuid        REFERENCES auth.users(id),
  reviewed_at         timestamptz,
  review_note         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER lease_change_sets_updated_at
  BEFORE UPDATE ON public.lease_change_sets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. lease_change_set_items
--    Field-level proposed changes within a change set.
-- ----------------------------------------------------------------------------
CREATE TABLE public.lease_change_set_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  change_set_id    uuid        NOT NULL REFERENCES public.lease_change_sets(id) ON DELETE CASCADE,
  field_name       text        NOT NULL,
  field_label      text        NOT NULL,
  old_value        text,
  proposed_value   text,
  source_section   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 4. Useful indexes
-- ----------------------------------------------------------------------------
CREATE INDEX idx_lease_unlock_requests_lease_id
  ON public.lease_unlock_requests(lease_id);

CREATE INDEX idx_lease_unlock_requests_workspace_status
  ON public.lease_unlock_requests(workspace_id, status);

CREATE INDEX idx_lease_change_sets_lease_id
  ON public.lease_change_sets(lease_id);

CREATE INDEX idx_lease_change_sets_workspace_status
  ON public.lease_change_sets(workspace_id, status);

CREATE INDEX idx_lease_change_set_items_change_set_id
  ON public.lease_change_set_items(change_set_id);

-- ----------------------------------------------------------------------------
-- 5. Row Level Security
-- ----------------------------------------------------------------------------
ALTER TABLE public.lease_unlock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_change_sets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_change_set_items ENABLE ROW LEVEL SECURITY;

-- lease_unlock_requests: workspace members can read; requester + admin can insert/update
CREATE POLICY "workspace members can view unlock requests"
  ON public.lease_unlock_requests FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "workspace members can create unlock requests"
  ON public.lease_unlock_requests FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "admins and requesters can update unlock requests"
  ON public.lease_unlock_requests FOR UPDATE
  USING (
    -- The requester can cancel their own request
    requested_by = auth.uid()
    OR
    -- Admins can approve/reject
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
    OR
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

-- lease_change_sets: workspace members can read; submitter + financial_approver/admin can write
CREATE POLICY "workspace members can view change sets"
  ON public.lease_change_sets FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "workspace members can create change sets"
  ON public.lease_change_sets FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "submitters and approvers can update change sets"
  ON public.lease_change_sets FOR UPDATE
  USING (
    submitted_by = auth.uid()
    OR
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
    OR
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
    OR
    -- financial_approver functional role
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_roles
      WHERE user_id = auth.uid()
        AND role = 'financial_approver'
    )
  );

-- lease_change_set_items: inherit via change_set join
CREATE POLICY "workspace members can view change set items"
  ON public.lease_change_set_items FOR SELECT
  USING (
    change_set_id IN (
      SELECT id FROM public.lease_change_sets
      WHERE workspace_id IN (
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "workspace members can insert change set items"
  ON public.lease_change_set_items FOR INSERT
  WITH CHECK (
    change_set_id IN (
      SELECT id FROM public.lease_change_sets
      WHERE workspace_id IN (
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "workspace members can delete change set items"
  ON public.lease_change_set_items FOR DELETE
  USING (
    change_set_id IN (
      SELECT id FROM public.lease_change_sets
      WHERE workspace_id IN (
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 6. Extend lease_activity_log activity_type CHECK constraint
-- ----------------------------------------------------------------------------
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    'status_change',
    'approval',
    'rejection',
    'send_back',
    'pause',
    'nudge_sent',
    'document_upload',
    'created',
    'comment',
    'executed_uploaded',
    'executed_terms_extracted',
    'model_locked',
    'unlock_requested',
    'unlock_approved',
    'unlock_rejected',
    'change_submitted',
    'change_approved',
    'change_rejected',
    'change_canceled'
  ));
