-- Create lease_notifications table for user-controlled notification preferences
CREATE TABLE public.lease_notifications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('expiration', 'escalation', 'renewal_window', 'commencement', 'custom')),
  event_date DATE NOT NULL,
  event_description TEXT,
  notify_days_before INTEGER[] NOT NULL DEFAULT '{90, 60, 30, 14, 7}',
  notify_email BOOLEAN NOT NULL DEFAULT true,
  is_confirmed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.lease_notifications ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can manage notifications for their own leases
CREATE POLICY "Users can view notifications for their leases"
ON public.lease_notifications
FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.leases
  WHERE leases.id = lease_notifications.lease_id
  AND leases.user_id = auth.uid()
));

CREATE POLICY "Users can create notifications for their leases"
ON public.lease_notifications
FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.leases
  WHERE leases.id = lease_notifications.lease_id
  AND leases.user_id = auth.uid()
));

CREATE POLICY "Users can update notifications for their leases"
ON public.lease_notifications
FOR UPDATE
USING (EXISTS (
  SELECT 1 FROM public.leases
  WHERE leases.id = lease_notifications.lease_id
  AND leases.user_id = auth.uid()
));

CREATE POLICY "Users can delete notifications for their leases"
ON public.lease_notifications
FOR DELETE
USING (EXISTS (
  SELECT 1 FROM public.leases
  WHERE leases.id = lease_notifications.lease_id
  AND leases.user_id = auth.uid()
));

-- Add trigger for updated_at
CREATE TRIGGER update_lease_notifications_updated_at
BEFORE UPDATE ON public.lease_notifications
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for efficient queries
CREATE INDEX idx_lease_notifications_lease_id ON public.lease_notifications(lease_id);
CREATE INDEX idx_lease_notifications_event_date ON public.lease_notifications(event_date);
CREATE INDEX idx_lease_notifications_confirmed ON public.lease_notifications(is_confirmed) WHERE is_confirmed = true;