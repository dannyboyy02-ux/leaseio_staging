-- Add average confidence score column to leases
ALTER TABLE public.leases ADD COLUMN IF NOT EXISTS avg_confidence_score NUMERIC(3,2);

-- Create index for faster filtering by confidence
CREATE INDEX IF NOT EXISTS idx_leases_avg_confidence ON public.leases(avg_confidence_score) WHERE avg_confidence_score IS NOT NULL;

-- Create table for per-field confidence tracking
CREATE TABLE IF NOT EXISTS public.lease_field_confidence (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  confidence_score NUMERIC(3,2) NOT NULL,
  was_corrected BOOLEAN DEFAULT false,
  corrected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(lease_id, field_name)
);

-- Enable RLS
ALTER TABLE public.lease_field_confidence ENABLE ROW LEVEL SECURITY;

-- RLS policy for viewing field confidence
CREATE POLICY "Users can view field confidence for their leases" 
ON public.lease_field_confidence FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.leases l 
  WHERE l.id = lease_field_confidence.lease_id 
  AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
));

-- RLS policy for inserting (service role will bypass, but good to have)
CREATE POLICY "Users can insert field confidence for their leases" 
ON public.lease_field_confidence FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.leases l 
  WHERE l.id = lease_field_confidence.lease_id 
  AND l.user_id = auth.uid()
));

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_field_confidence_lease_id ON public.lease_field_confidence(lease_id);
CREATE INDEX IF NOT EXISTS idx_field_confidence_low_scores ON public.lease_field_confidence(confidence_score) WHERE confidence_score < 0.85;

-- Trigger function to update average confidence
CREATE OR REPLACE FUNCTION update_lease_avg_confidence() 
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.leases 
  SET avg_confidence_score = (
    SELECT AVG(confidence_score) 
    FROM public.lease_field_confidence 
    WHERE lease_id = NEW.lease_id
  ) 
  WHERE id = NEW.lease_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger
DROP TRIGGER IF EXISTS update_avg_confidence_on_insert ON public.lease_field_confidence;
CREATE TRIGGER update_avg_confidence_on_insert 
AFTER INSERT OR UPDATE ON public.lease_field_confidence 
FOR EACH ROW EXECUTE FUNCTION update_lease_avg_confidence();