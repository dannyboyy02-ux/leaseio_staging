import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { StatTile } from '@/components/ui/stat-tile';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { getMonthlyRent } from '@/lib/leaseCalculations';
import { useNeedsAction } from '@/hooks/useNeedsAction';

interface StatBox {
  label: string;
  primary: string;
  /** Uncompacted figure for the hover title, when `primary` is abbreviated. */
  primaryFull?: string;
  sub: string;
  accent?: 'blue' | 'orange' | 'red' | 'default';
  href: string;
  disabled?: boolean;
  onDismiss?: () => void;
}

export function SummaryStrip() {
  const { t, language } = useLanguage();
  const { workspace } = useApp();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
  const formatCurrencyDecimals = (value: number | null | undefined) => formatLocalizedCurrency(value, language, { cents: true });
  const navigate = useNavigate();
  // The "Needs Action" tile is driven by the SAME source as the "Needs Your
  // Action" card (useNeedsAction, shared react-query cache) so the two can
  // never contradict — the card is hidden when this reads 0, so a divergent
  // count would have shown "All clear" above a card listing work (polish
  // review HIGH). These are MY action items, not a lifecycle-status count.
  const { data: naData } = useNeedsAction();
  const naTotal =
    (naData?.pendingApprovals?.length ?? 0) +
    (naData?.returnedLeases?.length ?? 0) +
    (naData?.unlockedLeases?.length ?? 0) +
    (naData?.otherFlags?.filter((f) => f.count > 0).length ?? 0);
  const naAwaiting = naData?.pendingApprovals?.length ?? 0;
  const [stats, setStats] = useState<StatBox[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const expiringIds90Ref = useRef<string[]>([]);
  const expiringIds120Ref = useRef<string[]>([]);

  // Combined "mark as seen" for BOTH expiry buckets (90 + 91-120): snapshots
  // the raw localStorage values before merging so the sonner undo action can
  // restore the exact pre-dismiss state (same undo pattern as Leases.tsx).
  const handleDismissExpiring = () => {
    if (!workspace?.id) return;
    const key90 = `leaseio_dismissed_expiry90_${workspace.id}`;
    const key120 = `leaseio_dismissed_expiry120_${workspace.id}`;
    const prev90 = localStorage.getItem(key90);
    const prev120 = localStorage.getItem(key120);
    const set90 = new Set<string>(JSON.parse(prev90 || '[]'));
    const set120 = new Set<string>(JSON.parse(prev120 || '[]'));
    const added = [
      ...expiringIds90Ref.current.filter((id) => !set90.has(id)),
      ...expiringIds120Ref.current.filter((id) => !set120.has(id)),
    ];
    if (added.length === 0) return; // double-click guard: nothing new to dismiss, keep the first toast's undo valid
    expiringIds90Ref.current.forEach((id) => set90.add(id));
    expiringIds120Ref.current.forEach((id) => set120.add(id));
    localStorage.setItem(key90, JSON.stringify([...set90]));
    localStorage.setItem(key120, JSON.stringify([...set120]));
    setRefreshKey((k) => k + 1);
    toast(t('dashboard.marked_seen_toast'), {
      id: 'expiring-seen',
      description: t('dashboard.marked_seen_scope'),
      action: {
        label: t('common.undo'),
        onClick: () => {
          if (prev90 === null) localStorage.removeItem(key90); else localStorage.setItem(key90, prev90);
          if (prev120 === null) localStorage.removeItem(key120); else localStorage.setItem(key120, prev120);
          setRefreshKey((k) => k + 1);
        },
      },
    });
  };

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) {
        setLoading(false);
        return;
      }

      const { data: leases } = await (supabase as any)
        .from('leases')
        .select(
          'id, lifecycle_status, executed_monthly_payment, current_monthly_rent, monthly_payment, executed_expiry_date, lease_end, square_footage, executed_document_url, ' +
          'rent_schedules(period_start, period_end, monthly_amount)'
        )
        .eq('workspace_id', workspace.id)
        .eq('archived', false);

      if (!leases) {
        setLoading(false);
        return;
      }

      const now = Date.now();
      const ninetyDaysMs    = 90  * 24 * 60 * 60 * 1000;
      const oneTwentyDaysMs = 120 * 24 * 60 * 60 * 1000;

      // Stat 1: Monthly Rent (active + executed leases) + weighted avg $/sqft.
      // Phase 3: include chain executed equivalent (fully_executed).
      const portfolioLeases = leases.filter(
        (l) =>
          l.lifecycle_status === 'active' ||
          l.lifecycle_status === 'executed' ||
          l.lifecycle_status === 'fully_executed'
      );
      const monthlyRentSum = portfolioLeases.reduce(
        (sum, l) => sum + getMonthlyRent(l as any),
        0
      );

      const leasesWithSqft = portfolioLeases.filter((l) => Number(l.square_footage ?? 0) > 0);
      const totalMonthlyRent = leasesWithSqft.reduce(
        (sum, l) => sum + getMonthlyRent(l as any),
        0
      );
      const totalSqft = leasesWithSqft.reduce((sum, l) => sum + Number(l.square_footage ?? 0), 0);
      const weightedAvgPerSqft = totalSqft > 0 ? totalMonthlyRent / totalSqft : null;

      const monthlyRentSub =
        weightedAvgPerSqft !== null
          ? t('dashboard.avg_per_sqft', { amount: formatCurrencyDecimals(weightedAvgPerSqft) })
          : t('dashboard.portfolio_leases', { count: portfolioLeases.length });

      // (The "Needs Action" tile is built in render from useNeedsAction so it
      // stays in lockstep with the Needs-Your-Action card — no lifecycle-count
      // recomputation here.)

      // Stat: Expiring within 90 days.
      // Phase 3 (KNOWN_ISSUES.md item #7): extended in place with the
      // chain executed_pre_active equivalent. Consolidation to a
      // STATE_GROUPS-derived helper is filed for a future refactor.
      const expiringStatuses = ['active', 'executed', 'fully_executed'];
      const expiringLeases = leases.filter((l) => {
        if (!expiringStatuses.includes(l.lifecycle_status ?? '')) return false;
        const expiryStr = l.executed_expiry_date ?? l.lease_end;
        if (!expiryStr) return false;
        const expiryTime = new Date(expiryStr).getTime();
        return expiryTime > now && expiryTime - now <= ninetyDaysMs;
      });

      // Stat 5: Expiring 91–120 days
      const expiring91to120Leases = leases.filter((l) => {
        if (!expiringStatuses.includes(l.lifecycle_status ?? '')) return false;
        const expiryStr = l.executed_expiry_date ?? l.lease_end;
        if (!expiryStr) return false;
        const diff = new Date(expiryStr).getTime() - now;
        return diff > ninetyDaysMs && diff <= oneTwentyDaysMs;
      });

      // Dismissed IDs from localStorage
      const dismissed90 = new Set<string>(
        JSON.parse(localStorage.getItem(`leaseio_dismissed_expiry90_${workspace.id}`) || '[]')
      );
      const dismissed120 = new Set<string>(
        JSON.parse(localStorage.getItem(`leaseio_dismissed_expiry120_${workspace.id}`) || '[]')
      );

      // Store raw IDs in refs for dismiss handler
      const allExpiring90Ids = expiringLeases.map((l: any) => l.id);
      const allExpiring120Ids = expiring91to120Leases.map((l: any) => l.id);
      expiringIds90Ref.current = allExpiring90Ids;
      expiringIds120Ref.current = allExpiring120Ids;

      // Prune stale dismissed IDs (leases no longer in the window)
      const validIds90 = new Set(allExpiring90Ids);
      const validIds120 = new Set(allExpiring120Ids);
      const pruned90 = [...dismissed90].filter((id) => validIds90.has(id));
      const pruned120 = [...dismissed120].filter((id) => validIds120.has(id));
      if (pruned90.length !== dismissed90.size) {
        localStorage.setItem(`leaseio_dismissed_expiry90_${workspace.id}`, JSON.stringify(pruned90));
      }
      if (pruned120.length !== dismissed120.size) {
        localStorage.setItem(`leaseio_dismissed_expiry120_${workspace.id}`, JSON.stringify(pruned120));
      }

      // Display counts exclude dismissed IDs
      const displayExpiring90Count = allExpiring90Ids.filter((id) => !dismissed90.has(id)).length;
      const displayExpiring120Count = allExpiring120Ids.filter((id) => !dismissed120.has(id)).length;

      const displayExpiringTotal = displayExpiring90Count + displayExpiring120Count;

      setStats([
        {
          label: t('dashboard.monthly_rent'),
          // Compact from six figures up — "$215,375" was ellipsizing to
          // "$215,7..." in the tile; "$215K" always fits.
          primary: monthlyRentSum >= 100_000
            ? formatLocalizedCurrency(monthlyRentSum, language, { compact: true })
            : formatCurrency(monthlyRentSum),
          // Exact figure on hover — the compacted "$215K" hides "$215,375".
          primaryFull: formatCurrency(monthlyRentSum),
          sub: monthlyRentSub,
          accent: 'default',
          href: '/app/leases?status=active',
        },
        {
          label: t('dashboard.expiring_120_combined'),
          primary: String(displayExpiringTotal),
          // Only ONE tile carries "all clear" on a clean workspace (that's the
          // Needs Action tile); here a neutral datum instead of a second
          // "all clear".
          sub:
            displayExpiringTotal === 0
              ? t('dashboard.none_within_120')
              : displayExpiring90Count > 0
                ? t('dashboard.within_90_days', { count: displayExpiring90Count })
                : t('dashboard.on_the_horizon'),
          accent: displayExpiring90Count > 0 ? 'red' : displayExpiringTotal > 0 ? 'orange' : 'default',
          href: '/app/leases?status=active&expiring=120',
          disabled: displayExpiringTotal === 0,
          onDismiss: displayExpiringTotal > 0 ? handleDismissExpiring : undefined,
        },
      ]);

      setLoading(false);
    }

    fetchData();
    // `language` re-runs the fetch on switch so the translated labels/subs
    // rebuild (mirrors IntakeTrend/CommitmentHistory).
  }, [workspace?.id, refreshKey, language]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse bg-muted h-24 rounded-xl" />
        ))}
      </div>
    );
  }


  // Compose the three tiles at render so the Needs Action tile reflects the
  // live useNeedsAction count (stats[0]=monthly, stats[1]=expiring from the
  // effect). Routes to /app/needs-action — the page that shows exactly these
  // items — not /app/approvals (a subset) or /app/leases (a superset).
  const needsActionTile: StatBox = {
    label: t('dashboard.needs_action'),
    primary: String(naTotal),
    sub:
      naTotal === 0
        ? t('dashboard.all_clear')
        : naAwaiting > 0
          ? t('dashboard.awaiting_approval_sub', { count: naAwaiting })
          : t('dashboard.items_need_attention', { count: naTotal }),
    accent: naTotal > 0 ? 'blue' : 'default',
    href: '/app/needs-action',
    disabled: naTotal === 0,
  };
  const displayStats: StatBox[] = stats.length >= 2
    ? [stats[0], needsActionTile, stats[1]]
    : stats;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {displayStats.map((box) => (
        <StatTile
          key={box.label}
          label={box.label}
          labelTitle={box.label}
          value={box.primary}
          valueTitle={box.primaryFull ?? box.primary}
          sub={box.sub}
          accent={box.accent}
          onClick={box.disabled ? undefined : () => navigate(box.href)}
          trailing={
            box.onDismiss ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); box.onDismiss!(); }}
                className="text-muted-foreground/40 transition-colors hover:text-green-500"
                title={t('dashboard.mark_as_seen')}
              >
                <Check className="h-3 w-3" />
              </button>
            ) : undefined
          }
        />
      ))}
    </div>
  );
}
