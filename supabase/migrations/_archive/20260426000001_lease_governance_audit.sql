-- ============================================================================
-- Lease Governance Audit Table
-- ============================================================================
-- Provides a flat, denormalized, append-only audit trail for all governance
-- events on model_locked active leases. Satisfies reporting requirements
-- without requiring multi-table JOINs.
--
-- This is separate from lease_activity_log (which tracks general workflow
-- events) and lease_change_set_items (which tracks staged values).
-- Actor emails are denormalized at write time so historical records
-- remain accurate even if users change their email address.
-- ============================================================================

CREATE TABLE public.lease_governance_audit (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id                    uuid        NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  workspace_id                uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type                  text        NOT NULL CHECK (event_type IN (
    'unlock_requested',
    'unlock_approved',
    'unlock_rejected',
    'change_set_created',
    'field_change_staged',
    'change_set_submitted',
    'change_set_approved',
    'field_change_committed',
    'change_set_rejected',
    'change_set_canceled',
    'lease_relocked'
  )),
  actor_user_id               uuid        REFERENCES auth.users(id),
  actor_email                 text,
  related_unlock_request_id   uuid        REFERENCES public.lease_unlock_requests(id),
  related_change_set_id       uuid        REFERENCES public.lease_change_sets(id),
  field_name                  text,
  field_label                 text,
  old_value                   text,
  proposed_value              text,
  final_value                 text,
  change_summary              text,
  rejection_reason            text,
  cancellation_reason         text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- Append-only: no UPDATE or DELETE policies
ALTER TABLE public.lease_governance_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace members can view governance audit"
  ON public.lease_governance_audit FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "workspace members can insert governance audit"
  ON public.lease_governance_audit FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );

-- Indexes for common query patterns
CREATE INDEX idx_governance_audit_lease_id
  ON public.lease_governance_audit(lease_id, created_at DESC);

CREATE INDEX idx_governance_audit_workspace_id
  ON public.lease_governance_audit(workspace_id, created_at DESC);

CREATE INDEX idx_governance_audit_change_set_id
  ON public.lease_governance_audit(related_change_set_id)
  WHERE related_change_set_id IS NOT NULL;

-- ============================================================================
-- Audit Report View
-- Returns a flat, report-ready view of all governance events per workspace.
-- Joins lease name and title for display. No email joins needed (denormalized).
-- ============================================================================
CREATE VIEW public.v_governance_audit_report AS
SELECT
  gau.id,
  gau.created_at                      AS event_timestamp,
  gau.event_type,
  gau.workspace_id,
  gau.lease_id,
  COALESCE(l.request_title, l.filename, 'Unnamed lease') AS lease_name,
  gau.actor_user_id,
  gau.actor_email,
  gau.related_unlock_request_id,
  gau.related_change_set_id,
  gau.field_name,
  gau.field_label,
  gau.old_value,
  gau.proposed_value,
  gau.final_value,
  gau.change_summary,
  gau.rejection_reason,
  gau.cancellation_reason
FROM  public.lease_governance_audit gau
JOIN  public.leases l ON l.id = gau.lease_id
ORDER BY gau.created_at DESC;
