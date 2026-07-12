// RerouteHistorySection — Phase 6 Checkpoint 4.
//
// Lists every lease_reroute_events row for a lease, chronologically
// (most recent first). Each row shows: triggered_at, triggered_by name,
// prior policy → new policy, changed_attributes diff, steps added /
// superseded / preserved counts, chain_violation badge.
//
// Auto-hides when there are no reroute events. The activity log
// timeline already shows the inline chain_rerouted events; this is the
// structured view for admins and auditors.

import { useEffect, useState } from 'react';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';
import { localizedStatusLabel } from '@/lib/lifecycleLabels';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp, GitBranch, Shield } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface RerouteEvent {
  id: string;
  triggered_at: string;
  triggered_by: string | null;
  trigger_reason: string | null;
  prior_policy_id: string | null;
  prior_policy_version: number | null;
  new_policy_id: string | null;
  new_policy_version: number | null;
  changed_attributes: Record<string, { from: unknown; to: unknown }> | null;
  prior_lifecycle_status: string;
  new_lifecycle_status: string;
  steps_added_count: number;
  steps_superseded_count: number;
  steps_preserved_count: number;
  detection_mode: 'auto' | 'manual_admin' | 'manual_audit';
  resulted_in_chain_violation: boolean;
  notes: string | null;
}

interface PolicyMeta {
  id: string;
  name: string | null;
}

interface RerouteHistorySectionProps {
  leaseId: string;
}

// Values are i18n keys, resolved at render.
const MODE_LABEL: Record<RerouteEvent['detection_mode'], string> = {
  auto: 'leases.reroute.mode_auto',
  manual_admin: 'leases.reroute.mode_manual_admin',
  manual_audit: 'leases.reroute.mode_manual_audit',
};

function formatAttrValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function RerouteHistorySection({ leaseId }: RerouteHistorySectionProps) {
  const { t } = useAppTranslation();
  const [events, setEvents] = useState<RerouteEvent[]>([]);
  const [policies, setPolicies] = useState<Map<string, PolicyMeta>>(new Map());
  const [users, setUsers] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: rows, error } = await supabase
        .from('lease_reroute_events')
        .select(
          'id, triggered_at, triggered_by, trigger_reason, prior_policy_id, prior_policy_version, new_policy_id, new_policy_version, changed_attributes, prior_lifecycle_status, new_lifecycle_status, steps_added_count, steps_superseded_count, steps_preserved_count, detection_mode, resulted_in_chain_violation, notes',
        )
        .eq('lease_id', leaseId)
        .order('triggered_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        console.error('[RerouteHistorySection] load error:', error.message);
        setEvents([]);
        setLoading(false);
        return;
      }
      const list = (rows ?? []) as RerouteEvent[];
      setEvents(list);

      // Hydrate policy names + user display names for any referenced ids.
      const policyIds = Array.from(
        new Set(
          list.flatMap((e) => [e.prior_policy_id, e.new_policy_id]).filter(Boolean) as string[],
        ),
      );
      const userIds = Array.from(
        new Set(list.map((e) => e.triggered_by).filter(Boolean) as string[]),
      );
      const [policyResult, userResult] = await Promise.all([
        policyIds.length > 0
          ? supabase.from('approval_policies').select('id, name').in('id', policyIds)
          : Promise.resolve({ data: [] as PolicyMeta[] }),
        userIds.length > 0
          ? supabase.from('profiles').select('id, email, first_name, last_name').in('id', userIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      if (cancelled) return;
      const polMap = new Map<string, PolicyMeta>();
      for (const p of ((policyResult as any).data ?? []) as PolicyMeta[]) polMap.set(p.id, p);
      setPolicies(polMap);
      const userMap = new Map<string, string>();
      for (const u of ((userResult as any).data ?? []) as any[]) {
        const fn = (u.first_name as string | null) ?? '';
        const ln = (u.last_name as string | null) ?? '';
        const display = (fn || ln) ? `${fn} ${ln}`.trim() : (u.email ?? t('common.unknown'));
        userMap.set(u.id as string, display);
      }
      setUsers(userMap);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) return null;
  if (events.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <GitBranch className="h-4 w-4" />
          {t('leases.reroute.history_title')}
          <Badge variant="secondary" className="ml-1">
            {events.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {events.map((e) => {
          const isOpen = expanded.has(e.id);
          const priorName = e.prior_policy_id
            ? (policies.get(e.prior_policy_id)?.name ?? t('leases.reroute.policy_short', { id: e.prior_policy_id.slice(0, 8) }))
            : t('leases.reroute.no_prior_policy');
          const newName = e.new_policy_id
            ? (policies.get(e.new_policy_id)?.name ?? t('leases.reroute.policy_short', { id: e.new_policy_id.slice(0, 8) }))
            : '—';
          const triggerName = e.triggered_by
            ? (users.get(e.triggered_by) ?? t('workspace.members_panel.unknown_user'))
            : t('leases.reroute.system');
          const changedKeys = e.changed_attributes
            ? Object.keys(e.changed_attributes)
            : [];
          return (
            <div
              key={e.id}
              className={cn(
                'rounded-md border p-3 transition-colors',
                e.resulted_in_chain_violation
                  ? 'border-l-4 border-l-destructive bg-destructive/5'
                  : 'hover:bg-muted/30',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap text-sm">
                    <span className="font-medium">
                      {priorName} → {newName}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {t(MODE_LABEL[e.detection_mode])}
                    </Badge>
                    {e.resulted_in_chain_violation && (
                      <Badge variant="destructive" className="text-[10px] gap-0.5">
                        <Shield className="h-2.5 w-2.5" />
                        {t('leases.reroute.chain_violation_badge')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {format(new Date(e.triggered_at), 'MMM d, yyyy h:mm a')} ·{' '}
                    {t('leases.reroute.triggered_by', { name: triggerName })}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs mt-1">
                    <span>
                      <span className="text-muted-foreground">{t('leases.reroute.lifecycle_label')}</span>{' '}
                      {localizedStatusLabel(e.prior_lifecycle_status as LifecycleStatus)} → {localizedStatusLabel(e.new_lifecycle_status as LifecycleStatus)}
                    </span>
                    <span>
                      <span className="text-muted-foreground">{t('leases.reroute.steps_label')}</span>{' '}
                      <span className="text-success">{t('leases.reroute.steps_added', { count: e.steps_added_count })}</span>,{' '}
                      <span className="text-destructive">{t('leases.reroute.steps_superseded', { count: e.steps_superseded_count })}</span>,{' '}
                      {t('leases.reroute.steps_preserved', { count: e.steps_preserved_count })}
                    </span>
                  </div>
                  {changedKeys.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {changedKeys.map((k) => (
                        <Badge key={k} variant="outline" className="text-[10px]">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toggle(e.id)}
                  className="shrink-0"
                >
                  {isOpen ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {isOpen && (
                <div className="mt-3 pt-3 border-t space-y-2 text-xs">
                  {e.trigger_reason && (
                    <div>
                      <span className="text-muted-foreground">{t('leases.reroute.trigger_reason')}</span>{' '}
                      {e.trigger_reason}
                    </div>
                  )}
                  {changedKeys.length > 0 && e.changed_attributes && (
                    <div className="space-y-1">
                      <p className="text-muted-foreground font-medium">
                        {t('leases.reroute.attribute_diff')}
                      </p>
                      <table className="w-full text-[11px]">
                        <thead className="text-muted-foreground">
                          <tr>
                            <th className="text-left py-0.5 pr-2">{t('leases.reroute.field')}</th>
                            <th className="text-left py-0.5 pr-2">{t('leases.reroute.from')}</th>
                            <th className="text-left py-0.5">{t('leases.reroute.to')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {changedKeys.map((k) => {
                            const change = e.changed_attributes![k];
                            return (
                              <tr key={k} className="border-t border-muted/40">
                                <td className="py-0.5 pr-2 font-medium">{k}</td>
                                <td className="py-0.5 pr-2 line-through text-muted-foreground">
                                  {formatAttrValue(change.from)}
                                </td>
                                <td className="py-0.5">{formatAttrValue(change.to)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {e.prior_policy_version != null && e.new_policy_version != null && (
                    <div>
                      <span className="text-muted-foreground">{t('leases.reroute.policy_version')}</span>{' '}
                      v{e.prior_policy_version} → v{e.new_policy_version}
                    </div>
                  )}
                  {e.notes && (
                    <div>
                      <span className="text-muted-foreground">{t('leases.reroute.notes_label')}</span> {e.notes}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
