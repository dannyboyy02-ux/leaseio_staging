-- Create rent_schedules table for industry-standard rent tracking
CREATE TABLE public.rent_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE,
  monthly_amount DECIMAL(12,2),
  annual_amount DECIMAL(12,2),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Add index for faster lookups
CREATE INDEX idx_rent_schedules_lease_id ON public.rent_schedules(lease_id);
CREATE INDEX idx_rent_schedules_period ON public.rent_schedules(period_start, period_end);

-- Enable RLS
ALTER TABLE public.rent_schedules ENABLE ROW LEVEL SECURITY;

-- RLS policies: users can only access rent schedules for their own leases
CREATE POLICY "Users can view rent schedules for their leases"
  ON public.rent_schedules
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.leases
      WHERE leases.id = rent_schedules.lease_id
      AND leases.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert rent schedules for their leases"
  ON public.rent_schedules
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.leases
      WHERE leases.id = rent_schedules.lease_id
      AND leases.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update rent schedules for their leases"
  ON public.rent_schedules
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.leases
      WHERE leases.id = rent_schedules.lease_id
      AND leases.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete rent schedules for their leases"
  ON public.rent_schedules
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.leases
      WHERE leases.id = rent_schedules.lease_id
      AND leases.user_id = auth.uid()
    )
  );

-- Trigger for updated_at
CREATE TRIGGER update_rent_schedules_updated_at
  BEFORE UPDATE ON public.rent_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Add new columns to leases table for enhanced rent tracking
ALTER TABLE public.leases 
  ADD COLUMN IF NOT EXISTS current_monthly_rent DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS rent_escalation_type TEXT;