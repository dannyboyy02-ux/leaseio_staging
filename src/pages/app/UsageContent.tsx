import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Sparkles, ArrowRight, Archive, Activity, Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { supabase } from '@/integrations/supabase/client';
import { PLANS } from '@/config/pricing';
import type { SubscriptionPlan } from '@/config/pricing';

interface RecentArchive {
  id: string;
  request_title: string | null;
  property_address: string | null;
  archived_at: string | null;
  archived_by_name: string | null;
}

const usageTone = (pct: number): 'destructive' | 'warning' | 'accent' => {
  if (pct >= 90) return 'destructive';
  if (pct >= 75) return 'warning';
  return 'accent';
};

interface Props {
  /** When true, show the "Manage subscription" action header — used on the
   *  standalone /app/usage page. Inside Settings the page header already
   *  handles that, so we hide it. */
  showHeader?: boolean;
}

export function UsageContent({ showHeader = false }: Props) {
  const { t } = useAppTranslation();
  const { workspace, availableWorkspaces } = useApp();
  const [recent, setRecent] = useState<RecentArchive[]>([]);

  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from('leases')
        .select(
          'id, request_title, property_address, archived_at, archived_by, profiles:archived_by(first_name, last_name)'
        )
        .eq('workspace_id', workspace.id)
        .eq('archived', true)
        .order('archived_at', { ascending: false })
        .limit(10);
      if (cancelled) return;
      const rows: RecentArchive[] = (data ?? []).map((r: any) => ({
        id: r.id,
        request_title: r.request_title,
        property_address: r.property_address,
        archived_at: r.archived_at,
        archived_by_name: r.profiles
          ? [r.profiles.first_name, r.profiles.last_name].filter(Boolean).join(' ') || null
          : null,
      }));
      setRecent(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  if (!workspace) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  const activeUsed = workspace.activeLeasesUsed ?? 0;
  const activeMax = workspace.maxActiveLeases ?? 0;
  const archivedUsed = workspace.archivedLeasesUsed ?? 0;
  const archivedMax = workspace.maxArchivedLeases ?? 0;
  const activePct = activeMax > 0 ? Math.min((activeUsed / activeMax) * 100, 100) : 0;
  const archivedPct = archivedMax > 0 ? Math.min((archivedUsed / archivedMax) * 100, 100) : 0;

  const planConfig = PLANS[workspace.plan as SubscriptionPlan] ?? PLANS.starter;
  const maxWorkspaces = planConfig.maxWorkspaces;
  const ownedCount = availableWorkspaces.filter((w) => w.role === 'owner').length;
  const workspacePct = maxWorkspaces > 0 ? Math.min((ownedCount / maxWorkspaces) * 100, 100) : 0;
  // Single-workspace plans always sit at 1/1 — that's the normal state, not
  // an approaching limit, so the meter and the banner only apply when the
  // plan actually allows multiple workspaces.
  const isMultiWorkspacePlan = maxWorkspaces > 1;
  const showUpgrade =
    activePct >= 75 || archivedPct >= 75 || (isMultiWorkspacePlan && workspacePct >= 75);

  return (
    <div className="space-y-6">
      {showHeader && (
        <div className="flex items-center justify-between gap-2">
          <Badge variant={workspace.plan === 'business' ? 'business' : 'secondary'}>
            {t(`plan.${workspace.plan}`)}
          </Badge>
          <Button variant="outline" size="sm" asChild>
            <Link to="/app/upgrade">
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              {t('usage.manage_subscription')}
            </Link>
          </Button>
        </div>
      )}

      {showUpgrade && (
        <Card className="border-amber-300 bg-amber-50/50 dark:bg-amber-950/10 dark:border-amber-800">
          <CardContent className="py-4 px-5 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t('usage.approaching_limit')}
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
                {t('usage.approaching_limit_desc')}
              </p>
            </div>
            <Button variant="accent" size="sm" asChild>
              <Link to="/app/upgrade" className="flex items-center gap-1.5">
                {t('usage.upgrade_plan')}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-muted-foreground" />
              {t('usage.active_leases')}
            </CardTitle>
            <CardDescription className="text-xs">
              {t('usage.active_leases_desc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-bold text-foreground">{activeUsed}</span>
              <span className="text-sm text-muted-foreground">
                / {activeMax === -1 ? t('usage.unlimited') : activeMax}
              </span>
            </div>
            <Progress value={activePct} variant={usageTone(activePct)} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {activeMax > 0
                ? t('usage.percent_used', { percent: Math.round(activePct) })
                : t('usage.unlimited')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4 text-muted-foreground" />
              {t('usage.archived_leases')}
            </CardTitle>
            <CardDescription className="text-xs">
              {t('usage.archived_leases_desc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-bold text-foreground">{archivedUsed}</span>
              <span className="text-sm text-muted-foreground">/ {archivedMax}</span>
            </div>
            <Progress value={archivedPct} variant={usageTone(archivedPct)} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {t('usage.percent_used', { percent: Math.round(archivedPct) })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              {t('usage.workspaces')}
            </CardTitle>
            <CardDescription className="text-xs">
              {t('usage.workspaces_desc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-bold text-foreground">{ownedCount}</span>
              <span className="text-sm text-muted-foreground">/ {maxWorkspaces}</span>
            </div>
            {isMultiWorkspacePlan ? (
              <>
                <Progress value={workspacePct} variant={usageTone(workspacePct)} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  {t('usage.percent_used', { percent: Math.round(workspacePct) })}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('usage.workspaces_upgrade_hint')}{' '}
                <Link to="/app/upgrade" className="text-accent underline underline-offset-2">
                  {t('usage.upgrade_plan')}
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('usage.recent_archives')}</CardTitle>
          <CardDescription className="text-xs">
            {t('usage.recent_archives_desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('usage.recent_archives_empty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((row) => (
                <li key={row.id}>
                  <Link
                    to={`/app/leases/${row.id}`}
                    className="flex items-center justify-between gap-4 py-3 hover:bg-muted/30 -mx-3 px-3 rounded transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {row.request_title || row.property_address || t('usage.untitled_lease')}
                      </p>
                      {row.archived_by_name && (
                        <p className="text-xs text-muted-foreground truncate">
                          {t('usage.archived_by', { name: row.archived_by_name })}
                        </p>
                      )}
                    </div>
                    {row.archived_at && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {format(new Date(row.archived_at), 'MMM d, yyyy')}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
