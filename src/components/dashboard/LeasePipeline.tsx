import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart2, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isEquivalent, type LifecycleStatus } from '@/lib/lifecycleStates';
import { formatLocalizedCurrency, type SupportedLocale } from '@/lib/dateFormatters';
import { getMonthlyRent } from '@/lib/leaseCalculations';

/**
 * Compact currency formatter — `$1.2M`, `$870K`, `$1.4B`. Keeps stage rows
 * narrow so the pipeline doesn't overflow on portfolios with $10M+ totals.
 */
const formatCompactCurrency = (value: number, language: SupportedLocale): string => {
  if (!Number.isFinite(value) || value === 0) return '$0';
  return formatLocalizedCurrency(value, language, { compact: true });
};

// "Active" in the pipeline = activated within this lookback window. Older
// active leases stay in the Portfolio dashboard but drop off the pipeline,
// which is meant to surface what's currently in motion — not the whole
// portfolio. 90 days = roughly one quarter of finance review cadence.
const ACTIVE_LOOKBACK_DAYS = 90;

// Labels are i18n keys, translated at render time (the `active` key also
// interpolates {{days}} = ACTIVE_LOOKBACK_DAYS).
const STAGES = [
  { key: 'submitted',    labelKey: 'dashboard.stage_submitted',    color: 'bg-blue-400',   href: '/app/approvals' },
  { key: 'under_review', labelKey: 'dashboard.stage_under_review', color: 'bg-amber-400',  href: '/app/approvals' },
  { key: 'approved',     labelKey: 'dashboard.stage_approved',     color: 'bg-purple-400', href: '/app/approvals' },
  { key: 'executed',     labelKey: 'dashboard.stage_executed',     color: 'bg-indigo-400', href: '/app/leases?status=active' },
  { key: 'active',       labelKey: 'dashboard.stage_active_days',  color: 'bg-green-500',  href: '/app/leases?status=active' },
] as const;

interface StageData {
  key: string;
  labelKey: string;
  color: string;
  href: string;
  count: number;
  annualValue: number;
}

export function LeasePipeline() {
  const { workspace } = useApp();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Live data: useQuery refetches on window focus + every 60s, and a
  // postgres-changes subscription invalidates on any leases table mutation
  // for this workspace so the dashboard reflects state changes immediately
  // (lock/unlock/approve/lifecycle transitions).
  const { data: stageData = [], isLoading } = useQuery<StageData[]>({
    queryKey: ['lease-pipeline', workspace?.id],
    enabled: !!workspace?.id,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      if (!workspace?.id) return [];
      const { data: leases } = await supabase
        .from('leases')
        .select('lifecycle_status, activated_at, executed_monthly_payment, current_monthly_rent, monthly_payment, rent_schedules(period_start, period_end, monthly_amount)')
        .eq('workspace_id', workspace.id)
        // Exclude archived leases — the rest of the dashboard already does.
        .eq('archived', false);
      if (!leases) return [];
      const cutoff = Date.now() - ACTIVE_LOOKBACK_DAYS * 86_400_000;
      return STAGES.map((stage) => {
        const matching = leases.filter((l) => {
          // Phase 3: bucket chain-vocabulary leases into the same stage as
          // their legacy equivalent (e.g. concept_submitted ↔ submitted)
          // so the pipeline view shows a unified picture across vocabularies.
          if (!isEquivalent(l.lifecycle_status as LifecycleStatus, stage.key as LifecycleStatus)) return false;
          if (stage.key === 'active') {
            // Only "recently activated" leases stay in the pipeline view.
            // If activated_at is null (legacy data), treat as not in scope —
            // those belong in the Portfolio dashboard, not the pipeline.
            const ts = (l as any).activated_at as string | null;
            if (!ts) return false;
            return new Date(ts).getTime() >= cutoff;
          }
          return true;
        });
        const annualValue = matching.reduce(
          (sum, l) => sum + getMonthlyRent(l as any) * 12,
          0
        );
        return {
          key: stage.key,
          labelKey: stage.labelKey,
          color: stage.color,
          href: stage.href,
          count: matching.length,
          annualValue,
        };
      });
    },
  });

  // Realtime subscription — any insert/update/delete on the workspace's
  // leases invalidates the query so the pipeline reflects state immediately
  // (no need to wait for the 60s refetch on lifecycle transitions).
  useEffect(() => {
    if (!workspace?.id) return;
    const channel = supabase
      .channel(`lease-pipeline-${workspace.id}`)
      .on(
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'leases', filter: `workspace_id=eq.${workspace.id}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['lease-pipeline', workspace.id] });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [workspace?.id, queryClient]);

  const maxCount = Math.max(...stageData.map((s) => s.count), 1);

  const approvalStages = ['submitted', 'under_review', 'approved'];
  // A single in-flight lease isn't a bottleneck — require at least 2 stacked.
  const bottleneckStage = stageData
    .filter((s) => approvalStages.includes(s.key) && s.count > 1)
    .sort((a, b) => b.count - a.count)[0]?.key ?? null;

  const inProgressCount = stageData
    .filter((s) => ['submitted', 'under_review', 'approved', 'executed'].includes(s.key))
    .reduce((sum, s) => sum + s.count, 0);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4" />
            {t('dashboard.lease_pipeline')}
          </div>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => navigate('/app/leases')}
          >
            {t('dashboard.full_pipeline')}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="animate-pulse bg-muted h-7 rounded" />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {/* Empty stages compress into one muted line below — five
                full bar rows of zeros read as noise, not pipeline. */}
            {stageData.filter((s) => s.count > 0).map((stage) => (
              <div
                key={stage.key}
                className="flex items-center gap-3 cursor-pointer hover:bg-muted/70 transition-colors rounded px-2 py-1.5"
                onClick={() => navigate(stage.href)}
              >
                <span className="w-28 text-xs text-muted-foreground shrink-0">
                  {t(stage.labelKey, { days: ACTIVE_LOOKBACK_DAYS })}
                </span>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${stage.color}`}
                    style={{ width: `${(stage.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-6 text-xs font-medium text-right shrink-0">
                  {stage.count}
                </span>
                <span
                  className="w-14 text-xs text-muted-foreground text-right shrink-0 tabular-nums"
                  title={formatLocalizedCurrency(stage.annualValue, language)}
                >
                  {formatCompactCurrency(stage.annualValue, language)}
                </span>
                {stage.key === bottleneckStage && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-600 bg-amber-100 rounded px-1.5 py-0.5 shrink-0">
                    <AlertCircle className="h-2.5 w-2.5" />
                    {t('dashboard.bottleneck')}
                  </span>
                )}
              </div>
            ))}
            {stageData.every((s) => s.count === 0) ? (
              <p className="text-sm text-muted-foreground text-center py-3">
                {t('dashboard.pipeline_empty')}
              </p>
            ) : stageData.some((s) => s.count === 0) ? (
              <p className="text-[11px] text-muted-foreground px-2 pt-1.5">
                {t('dashboard.pipeline_empty_stages', {
                  stages: stageData
                    .filter((s) => s.count === 0)
                    .map((s) => t(s.labelKey, { days: ACTIVE_LOOKBACK_DAYS }))
                    .join(' · '),
                })}
              </p>
            ) : null}
            <div className="pt-3 border-t mt-2 flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {t('dashboard.total_in_progress', { count: inProgressCount })}
              </p>
              <p className="text-[10px] text-muted-foreground italic">
                {t('dashboard.active_row_note', { days: ACTIVE_LOOKBACK_DAYS })}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
