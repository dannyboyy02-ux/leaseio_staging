-- Phase 6: Expand notification types and workspace-scoped access for pipeline events

ALTER TABLE public.lease_notifications
  DROP CONSTRAINT IF EXISTS lease_notifications_event_type_check;

ALTER TABLE public.lease_notifications
  ADD CONSTRAINT lease_notifications_event_type_check
  CHECK (event_type IN (
    'expiration',
    'escalation',
    'renewal_window',
    'commencement',
    'custom',
    'new_request',
    'status_changed',
    'document_uploaded'
  ));

DROP POLICY IF EXISTS "Users can view notifications for their leases" ON public.lease_notifications;
DROP POLICY IF EXISTS "Users can create notifications for their leases" ON public.lease_notifications;
DROP POLICY IF EXISTS "Users can update notifications for their leases" ON public.lease_notifications;
DROP POLICY IF EXISTS "Users can delete notifications for their leases" ON public.lease_notifications;

CREATE POLICY "Workspace members can view notifications"
ON public.lease_notifications
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.leases l
  WHERE l.id = lease_notifications.lease_id
  AND (l.user_id = auth.uid() OR public.is_workspace_member(l.workspace_id, auth.uid()))
));

CREATE POLICY "Workspace editors can create notifications"
ON public.lease_notifications
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.leases l
  WHERE l.id = lease_notifications.lease_id
  AND (
    l.user_id = auth.uid()
    OR public.has_workspace_permission(l.workspace_id, auth.uid(), 'editor')
  )
));

CREATE POLICY "Workspace editors can update notifications"
ON public.lease_notifications
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM public.leases l
  WHERE l.id = lease_notifications.lease_id
  AND (
    l.user_id = auth.uid()
    OR public.has_workspace_permission(l.workspace_id, auth.uid(), 'editor')
  )
));

CREATE POLICY "Workspace admins can delete notifications"
ON public.lease_notifications
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM public.leases l
  WHERE l.id = lease_notifications.lease_id
  AND (
    l.user_id = auth.uid()
    OR public.has_workspace_permission(l.workspace_id, auth.uid(), 'admin')
  )
));
