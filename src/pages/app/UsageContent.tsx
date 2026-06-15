import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowRight } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
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

// A single limit, rendered in the Claude Usage pattern: label on the left,
// the status (e.g. "67% used" or "Unlimited") right-aligned on the same
// line, a thin full-width bar beneath, and a muted descriptor below that.
// No per-metric card, icon, or hero number — the surrounding section frame
// carries the chrome so the rows read as one calm list.
function UsageRow({
  title,
  status,
  pct,
  tone,
  showBar = true,
  children,
}: {
  title: string;
  status: ReactNode;
  pct?: number;
  tone?: 'destructive' | 'warning' | 'accent';
  showBar?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-sm text-muted-foreground shrink-0">{status}</span>
      </div>
      {showBar && (
        <Progress value={pct ?? 0} variant={tone} className="h-1.5 mt-2.5" />
      )}
      {children && <div className="mt-2 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

export function UsageContent() {
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

  const addonCapacity = workspace?.addonDocumentCapacity ?? 0;
  const effectiveLimit = (workspace?.documentLimit ?? 0) + addonCapacity;
  const usageRatio =
    workspace && effectiveLimit > 0 ? workspace.documentsUsed / effectiveLimit : 0;
  const abstractionPct = Math.min(usageRatio * 100, 100);
  const activeUsed = workspace.activeLeasesUsed ?? 0;
  const activeMax = workspace.maxActiveLeases ?? 0;
  const archivedUsed = workspace.archivedLeasesUsed ?? 0;
  const archivedMax = workspace.maxArchivedLeases ?? 0;
  const activePct = activeMax > 0 ? Math.min((activeUsed / activeMax) * 100, 100) : 0;
  const archivedPct = archivedMax > 0 ? Math.min((archivedUsed / archivedMax) * 100, 100) : 0;
  const isUnlimitedActive = activeMax === -1;

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
    <div className="space-y-8">
      {showUpgrade && (
        <div className="rounded-lg border border-amber-300 bg-amber-50/50 dark:bg-amber-950/10 dark:border-amber-800 px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {t('usage.approaching_limit')}
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              {t('usage.approaching_limit_desc')}
            </p>
          </div>
          {/* Both plans land on Billing; only the label differs — a
              Business user already owns the top plan, so "upgrade" copy
              would loop them into buying what they have. */}
          <Button variant="accent" size="sm" asChild>
            <Link
              to="/app/settings/account?tab=billing"
              className="flex items-center gap-1.5"
            >
              {workspace.plan === 'business'
                ? t('usage.manage_subscription')
                : t('usage.upgrade_plan')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      )}

      {/* Plan usage — one sectioned list of limit rows (Claude Usage
          pattern). Every value here is read straight from the workspace /
          plan config; this surface is presentation only. */}
      <section>
        <h3 className="text-sm font-semibold text-foreground mb-3">
          {t('usage.section_plan_usage')}
        </h3>
        <div className="rounded-lg border divide-y divide-border">
          {/* AI abstraction quota. Effective allowance = base plan limit +
              active document-pack capacity; the ratio guards on the
              effective limit so a 0 limit can't divide-by-zero. */}
          <UsageRow
            title={t('usage.abstractions_title')}
            status={t('usage.percent_used_short', { percent: Math.round(abstractionPct) })}
            pct={abstractionPct}
            tone={usageTone(abstractionPct)}
          >
            <p>
              {t('usage.count_used', { used: workspace.documentsUsed, limit: effectiveLimit })}
              {addonCapacity > 0 && (
                <>
                  {' '}
                  {t('usage.includes_pack', {
                    base: workspace.documentLimit,
                    count: addonCapacity,
                  })}
                </>
              )}
            </p>
            <p className="mt-0.5">{t('usage.abstractions_window_note')}</p>
          </UsageRow>

          <UsageRow
            title={t('usage.active_leases')}
            status={
              isUnlimitedActive
                ? t('usage.unlimited')
                : t('usage.percent_used_short', { percent: Math.round(activePct) })
            }
            pct={activePct}
            tone={usageTone(activePct)}
            showBar={!isUnlimitedActive}
          >
            {!isUnlimitedActive && (
              <p>{t('usage.count_used', { used: activeUsed, limit: activeMax })}</p>
            )}
            <p className={isUnlimitedActive ? '' : 'mt-0.5'}>{t('usage.active_leases_desc')}</p>
          </UsageRow>

          <UsageRow
            title={t('usage.archived_leases')}
            status={t('usage.percent_used_short', { percent: Math.round(archivedPct) })}
            pct={archivedPct}
            tone={usageTone(archivedPct)}
          >
            <p>{t('usage.count_used', { used: archivedUsed, limit: archivedMax })}</p>
            <p className="mt-0.5">{t('usage.archived_leases_desc')}</p>
          </UsageRow>

          <UsageRow
            title={t('usage.workspaces')}
            status={
              isMultiWorkspacePlan
                ? t('usage.percent_used_short', { percent: Math.round(workspacePct) })
                : t('usage.count_used', { used: ownedCount, limit: maxWorkspaces })
            }
            pct={workspacePct}
            tone={usageTone(workspacePct)}
            showBar={isMultiWorkspacePlan}
          >
            {isMultiWorkspacePlan ? (
              <>
                <p>{t('usage.count_used', { used: ownedCount, limit: maxWorkspaces })}</p>
                <p className="mt-0.5">{t('usage.workspaces_desc')}</p>
              </>
            ) : (
              <p>
                {t('usage.workspaces_upgrade_hint')}{' '}
                <Link
                  to="/app/settings/account?tab=billing"
                  className="text-accent underline underline-offset-2"
                >
                  {t('usage.workspaces_upgrade_link')}
                </Link>
              </p>
            )}
          </UsageRow>
        </div>
      </section>

      {/* Recently archived — same row idiom as the limit list, rendered as
          a section rather than a boxed card. */}
      <section>
        <h3 className="text-sm font-semibold text-foreground mb-1">
          {t('usage.recent_archives')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">{t('usage.recent_archives_desc')}</p>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">{t('usage.recent_archives_empty')}</p>
        ) : (
          <ul className="rounded-lg border divide-y divide-border">
            {recent.map((row) => (
              <li key={row.id}>
                <Link
                  to={`/app/leases/${row.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5 hover:bg-muted/30 transition-colors"
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
      </section>
    </div>
  );
}
