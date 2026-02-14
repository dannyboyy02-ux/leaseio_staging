import { supabase } from '@/integrations/supabase/client';

type LeaseNotificationEventType =
  | 'new_request'
  | 'status_changed'
  | 'document_uploaded'
  | 'expiration'
  | 'escalation'
  | 'renewal_window'
  | 'commencement'
  | 'custom';

interface CreateLeaseNotificationInput {
  leaseId: string;
  eventType: LeaseNotificationEventType;
  description: string;
  eventDate?: string;
}

export async function createLeaseNotification({
  leaseId,
  eventType,
  description,
  eventDate,
}: CreateLeaseNotificationInput) {
  const date = eventDate || new Date().toISOString().slice(0, 10);

  const { error } = await supabase.from('lease_notifications').insert({
    lease_id: leaseId,
    event_type: eventType,
    event_date: date,
    event_description: description,
    notify_days_before: [0],
    notify_email: true,
    is_confirmed: true,
  });

  if (error) {
    console.error('Failed to create lease notification:', error);
  }
}
