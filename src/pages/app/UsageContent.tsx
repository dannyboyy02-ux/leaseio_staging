import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { PLANS, isReadOnlyRetention } from '@/config/pricing';
import type { SubscriptionPlan } from '@/config/pricing';

const usageTone = (pct: number): 'destructive' | 'warning' | 'accent' => {
  if (pct >= 90) return 'destructive';
  if (pct >= 75) return 'warning';
  return 'accent';
};

/**
 * One usage metric rendered as a Claude-style row: bold label left, terse
 * "N% used" right, a thin full-width bar beneath, and a small muted descriptor
 * below. `pct === null` hides the bar (unlimited / single-workspace plans);
 * `rightText === null` hides the right-aligned value. At the cap (pct >= 100)
 * the right-side percent is suppressed — the full bar + "M of M used" descriptor
 * already say it, so showing "100% used" too just triple-encodes one fact.
 */
function UsageRow({
  label,
  rightText,
  pct,
  variant,
  descriptor,
  action,
}: {
  label: string;
  rightText: string | null;
  pct: number | null;
  variant?: 'destructive' | 'warning' | 'accent';
  descriptor: ReactNode;
  /** Optional right-aligned action, rendered under the bar level with the
   *  descriptor (e.g. the Active-leases "Add capacity" button). */
  action?: ReactNode;
}) {
  const showRight = rightText && !(pct !== null && pct >= 100);
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {showRight && (
          <span className="text-sm text-muted-foreground shrink-0">{rightText}</span>
        )}
      </div>
      {pct !== null && (
        <Progress value={pct} variant={variant} className="h-1.5 mt-2" />
      )}
      {(descriptor || action) && (
        <div className="flex flex-wrap items-center justify-between gap-2 mt-1.5">
          {descriptor && (
            <div className="text-xs text-muted-foreground space-y-0.5">{descriptor}</div>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * @param onAddCapacity Opens the capacity-pack purchase dialog. Capacity packs
 *   raise the active-lease cap, so the "Add capacity" affordance lives on the
 *   Active leases row (moved off the Billing tab 2026-06-15 to keep Billing
 *   clean — act where you feel the limit). The dialog itself is owned by the
 *   parent (AccountSettings) so the quota-banner `?packs=1` deep-link reuses it.
 */
export function UsageContent({ onAddCapacity }: { onAddCapacity?: () => void } = {}) {
  const { t } = useAppTranslation();
  const { workspace, availableWorkspaces, userRole } = useApp();
  // Firm-bound: capacity is firm-managed, so the "approaching limit" CTA must
  // point at the firm owner, not the (now firm-locked) workspace Billing tab.
  const firmBound = Boolean(workspace?.firmId);

  if (!workspace) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  // Vault is a read-only retention offramp: AppContext zeroes its limits, so the
  // metered rows would show a meaningless all-zero "0 of 0" board plus an
  // "Upgrade to Business" hint that contradicts Vault's positioning. Guard it
  // out and show a calm read-only note instead. (#usage-vault-guard)
  const readOnlyRetention = isReadOnlyRetention(workspace.plan as SubscriptionPlan);

  // Plan changes are admin/owner-gated on the Billing tab. Members still see the
  // approaching-limit banner (it's their signal too), but sending them to a
  // billing surface they can't act on is a dead-end — so they get a "ask an
  // admin" line instead of the upgrade button.
  const isAdminUser = userRole === 'admin' || userRole === 'owner';

  const addonCapacity = workspace?.addonDocumentCapacity ?? 0;
  const effectiveLimit = (workspace?.documentLimit ?? 0) + addonCapacity;
  const usageRatio =
    workspace && effectiveLimit > 0 ? workspace.documentsUsed / effectiveLimit : 0;
  const abstractionPct = Math.min(usageRatio * 100, 100);
  const activeUsed = workspace.activeLeasesUsed ?? 0;
  const activeMax = workspace.maxActiveLeases ?? 0;
  const archivedUsed = workspace.archivedLeasesUsed ?? 0;
  const archivedMax = workspace.maxArchivedLeases ?? 0;
  const activeUnlimited = activeMax === -1;
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
  // The banner must cover the metered abstraction consumable too — it's the
  // one that drives overage, so a user at 14/15 abstractions needs the upgrade
  // path, not just a red bar. (#usage-abstraction-banner)
  const showUpgrade =
    !readOnlyRetention &&
    (abstractionPct >= 75 ||
      activePct >= 75 ||
      archivedPct >= 75 ||
      (isMultiWorkspacePlan && workspacePct >= 75));

  return (
    <div className="space-y-6">
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
            {/* Both plans land on Billing; only the label differs — a
                Business user already owns the top plan, so "upgrade" copy
                would loop them into buying what they have. Non-admins can't
                act on Billing, so they get a directive line instead.
                Firm-bound: Billing is firm-locked, so point at the firm owner. */}
            {firmBound ? (
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 shrink-0">
                {t('usage.firm_managed')}
              </p>
            ) : isAdminUser ? (
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
            ) : (
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 shrink-0">
                {t('usage.ask_admin_upgrade')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {readOnlyRetention ? (
        <Card>
          <CardContent className="py-5 px-5">
            <p className="text-sm font-semibold text-foreground">{t('usage.section_plan_usage')}</p>
            <p className="text-sm text-muted-foreground mt-1.5">{t('usage.vault_readonly_note')}</p>
            {/* Give the calm note one obvious next gesture instead of leaving it
                a dead-end — Vault access is owner-only, so whoever sees this can
                act on Billing. */}
            <Link
              to="/app/settings/account?tab=billing"
              className="inline-flex items-center gap-1.5 text-sm text-accent underline underline-offset-2 mt-3"
            >
              {t('usage.vault_reactivate_link')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </CardContent>
        </Card>
      ) : (
        /* Plan usage — one calm surface, each metric a row divided by a hairline.
           AI abstraction quota moved here from the Billing tab (2026-06-12) so
           usage has exactly one home. Effective allowance = base plan limit +
           active document-pack capacity; the ratio guards on the effective limit
           so a 0 limit can't divide-by-zero. */
        <Card>
          <CardContent className="py-5 px-5">
            <p className="text-sm font-semibold text-foreground">{t('usage.section_plan_usage')}</p>
            <div className="divide-y divide-border mt-3">
              <UsageRow
                label={t('usage.abstractions_title')}
                rightText={t('usage.percent_used_short', { percent: Math.round(abstractionPct) })}
                pct={abstractionPct}
                variant={usageTone(abstractionPct)}
                descriptor={
                  <>
                    <p>
                      {t('usage.count_used', {
                        used: workspace.documentsUsed,
                        limit: effectiveLimit,
                      })}
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
                    <p>{t('usage.abstractions_window_note')}</p>
                  </>
                }
              />

              <UsageRow
                label={t('usage.active_leases')}
                rightText={activeUnlimited ? t('usage.unlimited') : t('usage.percent_used_short', { percent: Math.round(activePct) })}
                pct={activeUnlimited ? null : activePct}
                variant={usageTone(activePct)}
                descriptor={
                  <>
                    {!activeUnlimited && (
                      <p>{t('usage.count_used', { used: activeUsed, limit: activeMax })}</p>
                    )}
                    <p>{t('usage.active_leases_desc')}</p>
                  </>
                }
                action={
                  isAdminUser && onAddCapacity ? (
                    <Button variant="outline" size="sm" onClick={onAddCapacity}>
                      {t('packs.card_cta')}
                    </Button>
                  ) : undefined
                }
              />

              <UsageRow
                label={t('usage.archived_leases')}
                rightText={t('usage.percent_used_short', { percent: Math.round(archivedPct) })}
                pct={archivedPct}
                variant={usageTone(archivedPct)}
                descriptor={
                  <>
                    <p>{t('usage.count_used', { used: archivedUsed, limit: archivedMax })}</p>
                    <p>{t('usage.archived_leases_desc')}</p>
                  </>
                }
              />

              <UsageRow
                label={t('usage.workspaces')}
                rightText={
                  isMultiWorkspacePlan
                    ? t('usage.percent_used_short', { percent: Math.round(workspacePct) })
                    : null
                }
                pct={isMultiWorkspacePlan ? workspacePct : null}
                variant={usageTone(workspacePct)}
                descriptor={
                  isMultiWorkspacePlan ? (
                    <>
                      <p>{t('usage.count_used', { used: ownedCount, limit: maxWorkspaces })}</p>
                      <p>{t('usage.workspaces_desc')}</p>
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
                  )
                }
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
