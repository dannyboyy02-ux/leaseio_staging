import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  FileText,
  Check,
  X,
  RotateCcw,
  Bell,
  Upload,
  MessageSquare,
  Pause,
  Plus,
  CheckCircle,
  XCircle,
  Lock,
  Unlock,
  Pencil,
  ScanText,
  Send,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import type { ActivityType } from '@/types/lifecycle';

interface ActivityEntry {
  id: string;
  activityType: ActivityType;
  fromStatus: string | null;
  toStatus: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  userEmail?: string;
}

interface ActivityTimelineProps {
  leaseId: string;
  className?: string;
}

const ACTIVITY_CONFIG: Record<ActivityType, {
  icon: typeof FileText;
  label: string;
  colorClass: string;
}> = {
  created: { icon: Plus, label: 'Created', colorClass: 'text-primary' },
  status_change: { icon: FileText, label: 'Status Changed', colorClass: 'text-info' },
  approval: { icon: Check, label: 'Approved', colorClass: 'text-success' },
  rejection: { icon: X, label: 'Rejected', colorClass: 'text-destructive' },
  send_back: { icon: RotateCcw, label: 'Sent Back', colorClass: 'text-warning' },
  pause: { icon: Pause, label: 'Paused', colorClass: 'text-muted-foreground' },
  nudge_sent: { icon: Bell, label: 'Nudge Sent', colorClass: 'text-info' },
  document_upload: { icon: Upload, label: 'Document Uploaded', colorClass: 'text-primary' },
  comment: { icon: MessageSquare, label: 'Comment', colorClass: 'text-muted-foreground' },
  // Phase 2 — approval chain
  manager_approved: { icon: CheckCircle, label: 'Manager Approved', colorClass: 'text-success' },
  manager_rejected: { icon: XCircle, label: 'Manager Rejected', colorClass: 'text-destructive' },
  financial_approved: { icon: CheckCircle, label: 'Financial Approved', colorClass: 'text-success' },
  financial_rejected: { icon: XCircle, label: 'Financial Rejected', colorClass: 'text-destructive' },
  financial_returned: { icon: RotateCcw, label: 'Returned for Revision', colorClass: 'text-warning' },
  resubmitted: { icon: RotateCcw, label: 'Resubmitted', colorClass: 'text-info' },
  // Phase 4 — executed record
  executed_uploaded: { icon: Upload, label: 'Executed Document Uploaded', colorClass: 'text-primary' },
  executed_terms_extracted: { icon: ScanText, label: 'Executed Terms Extracted', colorClass: 'text-info' },
  executed_terms_edited: { icon: Pencil, label: 'Executed Term Edited', colorClass: 'text-warning' },
  classification_resolved: { icon: CheckCircle, label: 'Classification Resolved', colorClass: 'text-success' },
  model_locked: { icon: Lock, label: 'Model Locked', colorClass: 'text-success' },
  // Governance workflow
  change_submitted: { icon: Send,        label: 'Changes Submitted', colorClass: 'text-info' },
  unlock_approved:  { icon: Unlock,      label: 'Unlock Approved',   colorClass: 'text-success' },
  unlock_rejected:  { icon: Lock,        label: 'Unlock Rejected',   colorClass: 'text-destructive' },
  change_approved:  { icon: CheckCircle, label: 'Changes Approved',  colorClass: 'text-success' },
  change_rejected:  { icon: XCircle,     label: 'Changes Rejected',  colorClass: 'text-destructive' },
  change_canceled:  { icon: XCircle,     label: 'Changes Discarded', colorClass: 'text-muted-foreground' },
};

export function ActivityTimeline({ leaseId, className }: ActivityTimelineProps) {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchActivities() {
      try {
        const { data, error } = await supabase
          .from('lease_activity_log')
          .select(`
            id,
            activity_type,
            from_status,
            to_status,
            details,
            created_at,
            profiles!lease_activity_log_user_id_fkey (
              email
            )
          `)
          .eq('lease_id', leaseId)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) {
          console.error('Error fetching activities:', error);
          return;
        }

        const mapped: ActivityEntry[] = (data || []).map((a: any) => ({
          id: a.id,
          activityType: a.activity_type,
          fromStatus: a.from_status,
          toStatus: a.to_status,
          details: a.details,
          createdAt: a.created_at,
          userEmail: a.profiles?.email,
        }));

        setActivities(mapped);
      } catch (err) {
        console.error('Error:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchActivities();
  }, [leaseId]);

  if (loading) {
    return (
      <div className={cn('space-y-4', className)}>
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 animate-pulse">
            <div className="w-8 h-8 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-muted rounded w-1/3" />
              <div className="h-3 bg-muted rounded w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className={cn('text-center py-8 text-muted-foreground', className)}>
        <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No activity yet</p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-4', className)}>
      {activities.map((activity, index) => {
        const config = ACTIVITY_CONFIG[activity.activityType] ?? {
          icon: FileText,
          label: activity.activityType,
          colorClass: 'text-muted-foreground',
        };
        const Icon = config.icon;
        const isLast = index === activities.length - 1;

        return (
          <div key={activity.id} className="flex gap-3 relative">
            {!isLast && (
              <div className="absolute left-4 top-8 bottom-0 w-px bg-border" />
            )}
            
            <div className={cn(
              'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-card border',
              config.colorClass
            )}>
              <Icon className="h-4 w-4" />
            </div>

            <div className="flex-1 min-w-0 pb-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{config.label}</p>
                  {activity.userEmail && (
                    <p className="text-xs text-muted-foreground">
                      by {activity.userEmail}
                    </p>
                  )}
                </div>
                <time className="text-xs text-muted-foreground whitespace-nowrap">
                  {format(new Date(activity.createdAt), 'MMM d, h:mm a')}
                </time>
              </div>

              {activity.details && (
                <div className="mt-1 text-sm text-muted-foreground space-y-0.5">
                  {activity.details.comment && (
                    <p className="italic">"{activity.details.comment as string}"</p>
                  )}
                  {activity.details.reason && (
                    <p>Reason: {activity.details.reason as string}</p>
                  )}
                  {activity.details.classification && (
                    <p>Classification: <span className="capitalize">{(activity.details.classification as string).replace(/_/g, ' ')}</span></p>
                  )}
                  {activity.details.filename && (
                    <p>File: {activity.details.filename as string}</p>
                  )}
                </div>
              )}

              {activity.fromStatus && activity.toStatus && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {activity.fromStatus.replace(/_/g, ' ')} → {activity.toStatus.replace(/_/g, ' ')}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
