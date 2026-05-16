-- Part 8: State Transition Audit Trail
CREATE TABLE IF NOT EXISTS public.lease_state_transitions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_lifecycle TEXT,
  to_lifecycle TEXT,
  transitioned_by UUID,
  transition_reason TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_lease ON public.lease_state_transitions(lease_id);
CREATE INDEX IF NOT EXISTS idx_state_transitions_date ON public.lease_state_transitions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_state_transitions_user ON public.lease_state_transitions(transitioned_by);

ALTER TABLE public.lease_state_transitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view transitions in workspace"
ON public.lease_state_transitions FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.leases l
  WHERE l.id = lease_state_transitions.lease_id
  AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
));

CREATE POLICY "Users can insert transitions for their leases"
ON public.lease_state_transitions FOR INSERT
WITH CHECK (
  transitioned_by = auth.uid() OR transitioned_by IS NULL
);

-- Trigger to auto-log transitions
CREATE OR REPLACE FUNCTION log_lease_state_change()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.status IS DISTINCT FROM NEW.status) OR 
     (OLD.lifecycle_status IS DISTINCT FROM NEW.lifecycle_status) THEN
    
    INSERT INTO public.lease_state_transitions (
      lease_id,
      from_status,
      to_status,
      from_lifecycle,
      to_lifecycle,
      transitioned_by,
      transition_reason,
      metadata
    ) VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      OLD.lifecycle_status,
      NEW.lifecycle_status,
      auth.uid(),
      NEW.rejection_reason,
      jsonb_build_object(
        'approver', NEW.approver_email,
        'submitted_at', NEW.submitted_for_approval_at,
        'internal_approved_at', NEW.internal_approved_at,
        'execution_approved_at', NEW.execution_approved_at
      )
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS lease_state_change_logger ON public.leases;
CREATE TRIGGER lease_state_change_logger
AFTER UPDATE ON public.leases
FOR EACH ROW
EXECUTE FUNCTION log_lease_state_change();