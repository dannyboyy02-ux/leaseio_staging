-- Table to track user corrections
CREATE TABLE IF NOT EXISTS public.field_corrections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  original_value TEXT,
  corrected_value TEXT,
  ai_confidence NUMERIC(3,2),
  corrected_by UUID,
  corrected_at TIMESTAMPTZ DEFAULT now(),
  correction_type TEXT CHECK (correction_type IN ('edit', 'add_missing', 'delete_wrong')),
  user_notes TEXT
);

ALTER TABLE public.field_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view corrections for their workspace leases" ON public.field_corrections FOR SELECT
USING (EXISTS (SELECT 1 FROM public.leases l WHERE l.id = field_corrections.lease_id AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))));

CREATE POLICY "Users can insert corrections for their leases" ON public.field_corrections FOR INSERT
WITH CHECK (EXISTS (SELECT 1 FROM public.leases l WHERE l.id = field_corrections.lease_id AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))));

CREATE INDEX IF NOT EXISTS idx_corrections_lease_id ON public.field_corrections(lease_id);
CREATE INDEX IF NOT EXISTS idx_corrections_field_name ON public.field_corrections(field_name);
CREATE INDEX IF NOT EXISTS idx_corrections_created_at ON public.field_corrections(corrected_at DESC);

-- Trigger to mark field as corrected in lease_field_confidence
CREATE OR REPLACE FUNCTION mark_field_as_corrected() RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.lease_field_confidence SET was_corrected = true, corrected_at = NEW.corrected_at
  WHERE lease_id = NEW.lease_id AND field_name = NEW.field_name;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER track_correction_on_field AFTER INSERT ON public.field_corrections FOR EACH ROW EXECUTE FUNCTION mark_field_as_corrected();