// RerouteAuditDashboard — Phase 6 Checkpoint 4.
//
// Admin-only page at /app/admin/reroute-audit. Lists the most recent
// reroute_audit_run activity rows for the current workspace. Each row
// is a finding from the daily reroute-audit-sweep cron — a lease where
// a reroute would have fired but the auto-trigger didn't catch it
// (typically because a policy was edited after the lease's chain was
// resolved, so no lease-attribute change ever fired the trigger).
//
// For each finding:
//   - "Trigger Manual Reroute" calls admin-trigger-manual-reroute
//   - "Open lease" navigates to the lease detail page
//
// "Mark as Acceptable" is intentionally NOT shipped in this checkpoint:
// the spec mentions it but doesn't pin down the activity-type that
// would record the choice, and the workflow already supports leaving a
// finding alone (the next sweep will re-detect; if admins keep ignoring
// it, the audit log accumulates the trail). A follow-up can wire the
// affordance once the audit-type vocabulary is settled.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatLocalizedDateTime } from '@/lib/dateFormatters';
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  Loader2,
  RotateCw,
  Search,
  Shield,
} from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';

import { localizedStatusLabel } from '@/lib/lifecycleLabels';
interface AuditFinding {
  id: string;
  lease_id: string;
  created_at: string;
  details: {
    would_reroute?: boolean;
    prior_policy_id?: string | null;
    new_policy_id?: string | null;
    prior_policy_version?: number | null;
    new_policy_version?: number | null;
    changed_attributes?: Record<string, { from: unknown; to: unknown }>;
    steps_added_count?: number;
    steps_superseded_count?: number;
    steps_preserved_count?: number;
    prior_lifecycle_status?: string;
    proposed_lifecycle_status?: string;
    proposed_chain_violation?: boolean;
  } | null;
  // Hydrated client-side
  lease_title?: string | null;
  prior_policy_name?: string | null;
  new_policy_name?: string | null;
}

export default function RerouteAuditDashboard() {
  const { t, language } = useAppTranslation();
  const { workspace, userRole } = useApp();
  const navigate = useNavigate();
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Reroute trigger dialog
  const [triggerTarget, setTriggerTarget] = useState<AuditFinding | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const isAdminOrOwner = userRole === 'admin' || userRole === 'owner';

  useEffect(() => {
    if (!workspace?.id) return;
    if (!isAdminOrOwner) return;
    let cancelled = false;
    (async () => {
      setLoading(true);

      // Pull every reroute_audit_run row for leases in this workspace.
      // The activity_log row's lease_id is workspace-scoped via RLS, so
      // we can fetch with a single query.
      const { data: activityRows, error } = await supabase
        .from('lease_activity_log')
        .select('id, lease_id, created_at, details')
        .eq('activity_type', 'reroute_audit_run')
        .order('created_at', { ascending: false })
        .limit(100);
      if (cancelled) return;
      if (error) {
        console.error('[RerouteAuditDashboard] load error:', error.message);
        setFindings([]);
        setLoading(false);
        return;
      }

      const items = ((activityRows ?? []) as AuditFinding[]).filter(
        (a) => a.details?.would_reroute === true,
      );
      // Dedupe by lease_id — show the most recent finding per lease.
      const seenLeases = new Set<string>();
      const dedup = items.filter((a) => {
        if (seenLeases.has(a.lease_id)) return false;
        seenLeases.add(a.lease_id);
        return true;
      });

      // Hydrate lease titles + workspace scoping (RLS on leases enforces
      // workspace).
      const leaseIds = dedup.map((d) => d.lease_id);
      const policyIds = Array.from(
        new Set(
          dedup
            .flatMap((d) => [d.details?.prior_policy_id, d.details?.new_policy_id])
            .filter(Boolean) as string[],
        ),
      );
      const [leaseResult, policyResult] = await Promise.all([
        leaseIds.length > 0
          ? supabase
              .from('leases')
              .select('id, request_title, filename, workspace_id')
              .in('id', leaseIds)
              .eq('workspace_id', workspace!.id)
          : Promise.resolve({ data: [] as any[] }),
        policyIds.length > 0
          ? supabase.from('approval_policies').select('id, name').in('id', policyIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      if (cancelled) return;

      const leaseMap = new Map<string, { title: string }>();
      for (const l of ((leaseResult as any).data ?? []) as any[]) {
        leaseMap.set(l.id, {
          title: l.request_title || l.filename || t('locked_lease.untitled'),
        });
      }
      const policyMap = new Map<string, string>();
      for (const p of ((policyResult as any).data ?? []) as any[]) {
        policyMap.set(p.id, p.name ?? t('exceptions.reroute.policy_fallback', { id: p.id.slice(0, 8) }));
      }

      const hydrated = dedup
        .filter((d) => leaseMap.has(d.lease_id)) // workspace scoping
        .map((d) => ({
          ...d,
          lease_title: leaseMap.get(d.lease_id)?.title ?? null,
          prior_policy_name: d.details?.prior_policy_id
            ? (policyMap.get(d.details.prior_policy_id) ?? null)
            : null,
          new_policy_name: d.details?.new_policy_id
            ? (policyMap.get(d.details.new_policy_id) ?? null)
            : null,
        }));

      setFindings(hydrated);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // (t included so hydrated fallback labels re-resolve on language change —
    // same pattern as Notifications.tsx)
  }, [workspace?.id, isAdminOrOwner, refreshKey, t]);

  const handleTrigger = async () => {
    if (!triggerTarget) return;
    if (reason.trim().length < 20) {
      toast.error(t('exceptions.reroute.reason_min'));
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'admin-trigger-manual-reroute',
        {
          body: { leaseId: triggerTarget.lease_id, reason: reason.trim() },
        },
      );
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || t('exceptions.reroute.failed');
        toast.error(msg);
        return;
      }
      const outcome = (data as any).manualRerouteOutcome;
      if (outcome === 'approved') {
        toast.success(t('exceptions.reroute.applied'));
      } else {
        toast.info(
          t('exceptions.reroute.no_reroute_needed', { reason: (data as any).reason ?? 'no_reroute_needed' }),
        );
      }
      setTriggerTarget(null);
      setReason('');
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      console.error('[RerouteAuditDashboard] trigger error:', err);
      toast.error(err?.message || t('exceptions.reroute.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (!isAdminOrOwner) {
    return (
      <AppLayout>
        <AppHeader title={t('exceptions.reroute.title')} />
        <PageLayout width="narrow">
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                {t('exceptions.admin_only')}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {t('exceptions.reroute.admin_only_desc')}
            </CardContent>
          </Card>
        </PageLayout>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title={t('exceptions.reroute.title')}
        subtitle={t('exceptions.reroute.subtitle')}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
          >
            <RotateCw className={cn('h-3.5 w-3.5 mr-1.5', loading && 'animate-spin')} />
            {t('analytics.refresh')}
          </Button>
        }
      />

      <PageLayout>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Search className="h-4 w-4" />
              {t('exceptions.reroute.findings')}
              <Badge variant="secondary" className="ml-1">
                {findings.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && findings.length === 0 && (
              <div className="text-center py-12 text-sm text-muted-foreground">
                {t('exceptions.reroute.none')}
              </div>
            )}
            {!loading &&
              findings.map((f) => {
                const changedKeys = f.details?.changed_attributes
                  ? Object.keys(f.details.changed_attributes)
                  : [];
                return (
                  <div
                    key={f.id}
                    className={cn(
                      'rounded-md border p-4 transition-colors',
                      f.details?.proposed_chain_violation
                        ? 'border-l-4 border-l-destructive bg-destructive/5'
                        : 'hover:bg-muted/30',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm">{f.lease_title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t('exceptions.detected_time', { time: formatLocalizedDateTime(f.created_at, language) })}
                        </p>
                        <div className="text-xs mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                          <span>
                            <span className="text-muted-foreground">{t('exceptions.reroute.policy_label')}</span>{' '}
                            {f.prior_policy_name ?? t('exceptions.reroute.none_policy')} →{' '}
                            <span className="font-medium">{f.new_policy_name ?? '—'}</span>
                          </span>
                          <span>
                            <span className="text-muted-foreground">{t('exceptions.reroute.lifecycle_label')}</span>{' '}
                            {f.details?.prior_lifecycle_status ? localizedStatusLabel(f.details.prior_lifecycle_status as LifecycleStatus) : '—'} →{' '}
                            {f.details?.proposed_lifecycle_status ? localizedStatusLabel(f.details.proposed_lifecycle_status as LifecycleStatus) : '—'}
                          </span>
                          <span>
                            <span className="text-muted-foreground">{t('exceptions.reroute.steps_label')}</span>{' '}
                            <span className="text-success">
                              +{f.details?.steps_added_count ?? 0}
                            </span>
                            ,{' '}
                            <span className="text-destructive">
                              {t('exceptions.reroute.superseded', { count: f.details?.steps_superseded_count ?? 0 })}
                            </span>
                          </span>
                          {f.details?.proposed_chain_violation && (
                            <Badge variant="destructive" className="text-[10px] gap-0.5">
                              <Shield className="h-2.5 w-2.5" />
                              {t('exceptions.reroute.would_violate')}
                            </Badge>
                          )}
                        </div>
                        {changedKeys.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {changedKeys.map((k) => (
                              <Badge
                                key={k}
                                variant="outline"
                                className="text-[10px]"
                              >
                                {k}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate(`/app/leases/${f.lease_id}`)}
                        >
                          <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                          {t('exceptions.reroute.open_lease')}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            setReason('');
                            setTriggerTarget(f);
                          }}
                        >
                          <ChevronRight className="h-3.5 w-3.5 mr-1.5" />
                          {t('exceptions.reroute.trigger')}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
          </CardContent>
        </Card>
      </PageLayout>

      <Dialog
        open={triggerTarget !== null}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setTriggerTarget(null);
            setReason('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('exceptions.reroute.trigger')}</DialogTitle>
            <DialogDescription>
              {t('exceptions.reroute.dialog_desc', { lease: triggerTarget?.lease_title })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reroute-reason">
              {t('exceptions.reroute.reason_label')}
            </Label>
            <Textarea
              id="reroute-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder={t('exceptions.reroute.reason_placeholder')}
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('exceptions.reroute.char_count', { count: reason.trim().length })}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setTriggerTarget(null);
                setReason('');
              }}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleTrigger}
              disabled={busy || reason.trim().length < 20}
            >
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('exceptions.reroute.trigger_short')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
