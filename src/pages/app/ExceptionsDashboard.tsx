// ExceptionsDashboard — Phase 7 Checkpoint 4.
//
// Admin-only page at /app/admin/exceptions. Surfaces governance
// exceptions that require attention:
//   - Stuck chains: leases pending 7+ days (from stuck_chain_detected
//     activity rows in the last 30 days)
//   - Deactivated approver alerts: policy_assignee_validation_failed
//     activity rows
//   - Recent overrides: chain_step_overrides rows from the last 30 days
//   - Active OOO declarations in the workspace
//
// Each panel auto-hides when empty. Each row links to the relevant
// lease detail.

import { useEffect, useState } from 'react';
import { stageLabel } from '@/lib/lifecycleStates';
import { useNavigate } from 'react-router-dom';
import { format, formatDistance } from 'date-fns';
import {
  AlertOctagon,
  AlertTriangle,
  CalendarOff,
  Clock,
  ExternalLink,
  Loader2,
  RotateCw,
  ShieldCheck,
  UserMinus,
} from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';

interface StuckRow {
  lease_id: string;
  created_at: string;
  details: any;
  lease_title?: string | null;
}
interface ValidationFailedRow {
  lease_id: string;
  created_at: string;
  details: any;
  lease_title?: string | null;
}
interface OverrideRow {
  id: string;
  lease_id: string;
  chain_step_id: string;
  override_action: string;
  override_reason: string;
  override_at: string;
  override_by: string;
  override_by_name?: string | null;
  lease_title?: string | null;
}
interface OOORow {
  id: string;
  user_id: string;
  delegate_user_id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  user_name?: string | null;
  delegate_name?: string | null;
}

export default function ExceptionsDashboard() {
  const { workspace, userRole } = useApp();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stuck, setStuck] = useState<StuckRow[]>([]);
  const [validationFailed, setValidationFailed] = useState<ValidationFailedRow[]>([]);
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [oooList, setOooList] = useState<OOORow[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const isAdminOrOwner = userRole === 'admin' || userRole === 'owner';

  useEffect(() => {
    if (!workspace?.id || !isAdminOrOwner) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Parallel queries
      const [stuckResp, vfResp, ovResp, oooResp] = await Promise.all([
        supabase
          .from('lease_activity_log')
          .select('lease_id, created_at, details')
          .eq('activity_type', 'stuck_chain_detected')
          .gte('created_at', cutoff30d)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('lease_activity_log')
          .select('lease_id, created_at, details')
          .eq('activity_type', 'policy_assignee_validation_failed')
          .gte('created_at', cutoff30d)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('chain_step_overrides')
          .select('id, lease_id, chain_step_id, override_action, override_reason, override_at, override_by')
          .eq('workspace_id', workspace.id)
          .gte('override_at', cutoff30d)
          .order('override_at', { ascending: false })
          .limit(100),
        supabase
          .from('user_out_of_office')
          .select('id, user_id, delegate_user_id, starts_at, ends_at, reason')
          .eq('workspace_id', workspace.id)
          .eq('is_active', true)
          .gte('ends_at', new Date().toISOString())
          .order('starts_at', { ascending: false })
          .limit(50),
      ]);
      if (cancelled) return;

      const stuckList = ((stuckResp.data ?? []) as StuckRow[]);
      const vfList = ((vfResp.data ?? []) as ValidationFailedRow[]);
      const ovList = ((ovResp.data ?? []) as OverrideRow[]);
      const oooListData = ((oooResp.data ?? []) as OOORow[]);

      // Hydrate lease titles + user names where needed
      const leaseIds = Array.from(new Set([
        ...stuckList.map((r) => r.lease_id),
        ...vfList.map((r) => r.lease_id),
        ...ovList.map((r) => r.lease_id),
      ]));
      const userIds = Array.from(new Set([
        ...ovList.map((r) => r.override_by),
        ...oooListData.map((r) => r.user_id),
        ...oooListData.map((r) => r.delegate_user_id),
      ].filter(Boolean) as string[]));

      const [leasesResp, profilesResp] = await Promise.all([
        leaseIds.length > 0
          ? supabase
              .from('leases')
              .select('id, request_title, filename, workspace_id')
              .in('id', leaseIds)
              .eq('workspace_id', workspace.id)
          : Promise.resolve({ data: [] as any[] }),
        userIds.length > 0
          ? supabase.from('profiles').select('id, email, first_name, last_name').in('id', userIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      if (cancelled) return;
      const leaseMap = new Map<string, string>();
      for (const l of ((leasesResp as any).data ?? []) as any[]) {
        leaseMap.set(l.id, l.request_title || l.filename || 'Untitled lease');
      }
      const userMap = new Map<string, string>();
      for (const p of ((profilesResp as any).data ?? []) as any[]) {
        const fn = (p.first_name as string | null) ?? '';
        const ln = (p.last_name as string | null) ?? '';
        userMap.set(p.id, (fn || ln) ? `${fn} ${ln}`.trim() : (p.email ?? 'Unknown'));
      }

      // Filter to workspace-scope (RLS already enforces this on tables
      // we own, but lease_activity_log has open SELECT — restrict by
      // hydrated lease set)
      setStuck(
        stuckList
          .filter((r) => leaseMap.has(r.lease_id))
          .map((r) => ({ ...r, lease_title: leaseMap.get(r.lease_id) ?? null })),
      );
      setValidationFailed(
        vfList
          .filter((r) => leaseMap.has(r.lease_id))
          .map((r) => ({ ...r, lease_title: leaseMap.get(r.lease_id) ?? null })),
      );
      setOverrides(
        ovList.map((r) => ({
          ...r,
          lease_title: leaseMap.get(r.lease_id) ?? null,
          override_by_name: userMap.get(r.override_by) ?? null,
        })),
      );
      setOooList(
        oooListData.map((r) => ({
          ...r,
          user_name: userMap.get(r.user_id) ?? null,
          delegate_name: userMap.get(r.delegate_user_id) ?? null,
        })),
      );
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspace?.id, isAdminOrOwner, refreshKey]);

  if (!isAdminOrOwner) {
    return (
      <AppLayout>
        <AppHeader title="Exceptions" />
        <div className="max-w-2xl mx-auto py-10">
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Admin only
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              The exceptions dashboard surfaces governance exceptions that
              require administrative attention. Only workspace owners and
              admins can access it.
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title="Exceptions"
        subtitle="Governance findings that need administrative attention"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
          >
            <RotateCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        }
      />

      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Stuck chains */}
            {stuck.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Stuck Chains
                    <Badge variant="secondary" className="ml-1">{stuck.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {stuck.map((r, i) => (
                    <div
                      key={`${r.lease_id}-${i}`}
                      className="flex items-center justify-between gap-3 rounded-md border p-3 hover:bg-muted/30 cursor-pointer"
                      onClick={() => navigate(`/app/leases/${r.lease_id}`)}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{r.lease_title}</p>
                        <p className="text-xs text-muted-foreground">
                          Detected {formatDistance(new Date(r.created_at), new Date(), { addSuffix: true })}
                          {' · '}
                          {(r.details?.days_stuck ?? '?')} days stuck in {r.details?.stage ? stageLabel(r.details.stage as string) : '—'}
                        </p>
                      </div>
                      <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Deactivated approver alerts */}
            {validationFailed.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <UserMinus className="h-4 w-4" />
                    Deactivated Approver Alerts
                    <Badge variant="secondary" className="ml-1">{validationFailed.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {validationFailed.map((r, i) => (
                    <div
                      key={`${r.lease_id}-${i}`}
                      className="flex items-center justify-between gap-3 rounded-md border-l-4 border-l-destructive border p-3 bg-destructive/5 hover:bg-destructive/10 cursor-pointer"
                      onClick={() => navigate(`/app/leases/${r.lease_id}`)}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{r.lease_title}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.details?.reason === 'no_policy_delegate_configured'
                            ? 'No policy delegate configured — manual reassignment required'
                            : r.details?.reason === 'policy_delegate_also_inactive'
                            ? 'Both original and policy delegate are inactive'
                            : 'Manual reassignment required'}
                          {' · '}
                          {formatDistance(new Date(r.created_at), new Date(), { addSuffix: true })}
                        </p>
                      </div>
                      <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Recent overrides */}
            {overrides.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4" />
                    Recent Admin Overrides
                    <Badge variant="secondary" className="ml-1">{overrides.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {overrides.map((r) => (
                    <div
                      key={r.id}
                      className="rounded-md border p-3 hover:bg-muted/30 cursor-pointer"
                      onClick={() => navigate(`/app/leases/${r.lease_id}`)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap text-sm">
                            <span className="font-medium truncate">{r.lease_title}</span>
                            <Badge variant="outline" className="text-[10px]">
                              {r.override_action}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {format(new Date(r.override_at), 'MMM d, yyyy h:mm a')}
                            {r.override_by_name && ` · by ${r.override_by_name}`}
                          </p>
                          <p className="text-xs italic mt-1 line-clamp-2">"{r.override_reason}"</p>
                        </div>
                        <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Active OOO */}
            {oooList.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CalendarOff className="h-4 w-4" />
                    Active Out-of-Office
                    <Badge variant="secondary" className="ml-1">{oooList.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {oooList.map((r) => (
                    <div key={r.id} className="rounded-md border p-3">
                      <p className="text-sm">
                        <strong>{r.user_name ?? 'Unknown'}</strong> →{' '}
                        <strong>{r.delegate_name ?? 'Unknown'}</strong>
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {format(new Date(r.starts_at), 'MMM d')} → {format(new Date(r.ends_at), 'MMM d, yyyy')}
                        {r.reason && ` · ${r.reason}`}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {stuck.length === 0 &&
              validationFailed.length === 0 &&
              overrides.length === 0 &&
              oooList.length === 0 && (
                <Card>
                  <CardContent className="py-12 text-center text-sm text-muted-foreground">
                    <AlertOctagon className="h-8 w-8 mx-auto mb-3 opacity-40" />
                    No exceptions detected. The cron functions check daily; come back if any flag.
                  </CardContent>
                </Card>
              )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
