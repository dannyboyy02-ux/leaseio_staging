import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { CheckCircle2, Lock, Pencil, Unlock, GitPullRequest, ShieldCheck, ShieldX } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAppTranslation } from '@/hooks/useAppTranslation';

import { SectionCard } from './SectionCard';

interface Props {
  leaseId: string;
  workspaceId: string | null | undefined;
}

interface AuditRow {
  id: string;
  event_type: string;
  actor_email: string | null;
  field_label: string | null;
  field_name: string | null;
  change_summary: string | null;
  rejection_reason: string | null;
  created_at: string;
}

interface UnlockRequestRow {
  id: string;
  status: string;
  requested_by: string | null;
  request_reason: string | null;
  created_at: string;
}

const EVENT_LABELS: Record<string, { label: string; icon: typeof CheckCircle2 }> = {
  unlock_requested: { label: 'Unlock requested', icon: GitPullRequest },
  unlock_approved: { label: 'Unlock approved', icon: ShieldCheck },
  unlock_rejected: { label: 'Unlock rejected', icon: ShieldX },
  change_set_created: { label: 'Change set created', icon: Pencil },
  field_change_staged: { label: 'Field change staged', icon: Pencil },
  change_set_submitted: { label: 'Changes submitted', icon: GitPullRequest },
  change_set_approved: { label: 'Changes approved', icon: ShieldCheck },
  field_change_committed: { label: 'Change committed', icon: CheckCircle2 },
  change_set_rejected: { label: 'Changes rejected', icon: ShieldX },
  change_set_canceled: { label: 'Changes canceled', icon: ShieldX },
  lease_relocked: { label: 'Lease re-locked', icon: Lock },
};

export function AuditTimelineCard({ leaseId, workspaceId }: Props) {
  const { t } = useAppTranslation();
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [unlockRows, setUnlockRows] = useState<UnlockRequestRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [auditRes, unlockRes] = await Promise.all([
          (supabase as any)
            .from('lease_governance_audit')
            .select('id, event_type, actor_email, field_label, field_name, change_summary, rejection_reason, created_at')
            .eq('lease_id', leaseId)
            .order('created_at', { ascending: false })
            .limit(50),
          (supabase as any)
            .from('lease_unlock_requests')
            .select('id, status, requested_by, request_reason, created_at')
            .eq('lease_id', leaseId)
            .order('created_at', { ascending: false })
            .limit(20),
        ]);
        if (cancelled) return;
        setAuditRows((auditRes.data ?? []) as AuditRow[]);
        setUnlockRows((unlockRes.data ?? []) as UnlockRequestRow[]);
      } catch (err) {
        console.error('AuditTimelineCard load error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId, workspaceId]);

  return (
    <SectionCard title={t('locked_lease.audit.title')}>
      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : auditRows.length === 0 && unlockRows.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{t('locked_lease.audit.empty_hint')}</p>
      ) : (
        <ol className="space-y-3">
          {auditRows.map((row) => {
            const meta = EVENT_LABELS[row.event_type] ?? { label: row.event_type, icon: CheckCircle2 };
            const Icon = meta.icon;
            return (
              <li key={row.id} className="flex gap-3 text-sm">
                <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-foreground">{meta.label}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {format(new Date(row.created_at), 'MMM d, yyyy h:mm a')}
                    </span>
                  </div>
                  {(row.actor_email || row.field_label || row.change_summary || row.rejection_reason) && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {row.actor_email ? <>by {row.actor_email}{(row.field_label || row.change_summary) ? ' — ' : ''}</> : null}
                      {row.field_label ? <>{row.field_label}</> : row.change_summary}
                      {row.rejection_reason ? <> — Reason: {row.rejection_reason}</> : null}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
