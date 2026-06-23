import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { getMonthlyRent } from '@/lib/leaseCalculations';

interface StatBox {
  label: string;
  primary: string;
  sub: string;
  accent?: 'blue' | 'orange' | 'red' | 'default';
  href: string;
  disabled?: boolean;
  onDismiss?: () => void;
}

export function SummaryStrip() {
  const { language } = useLanguage();
  const { workspace } = useApp();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
  const formatCurrencyDecimals = (value: number | null | undefined) => formatLocalizedCurrency(value, language, { cents: true });
  const navigate = useNavigate();
  const [stats, setStats] = useState<StatBox[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const expiringIds90Ref = useRef<string[]>([]);
  const expiringIds120Ref = useRef<string[]>([]);

  const handleDismiss = (bucket: '90' | '120') => {
    if (!workspace?.id) return;
    const idsRef = bucket === '90' ? expiringIds90Ref : expiringIds120Ref;
    const key = `leaseio_dismissed_expiry${bucket}_${workspace.id}`;
    const existing = new Set<string>(JSON.parse(localStorage.getItem(key) || '[]'));
    idsRef.current.forEach((id) => existing.add(id));
    localStorage.setItem(key, JSON.stringify([...existing]));
    setRefreshKey((k) => k + 1);
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
          ? `Avg ${formatCurrencyDecimals(weightedAvgPerSqft)}/sqft`
          : `${portfolioLeases.length} portfolio lease${portfolioLeases.length !== 1 ? 's' : ''}`;

      // Stat 2: Needs Action — leases requiring human attention.
      // Phase 3: extend with chain awaiting_concept + in_concept_review +
      // executed_pre_active equivalents.
      const needsActionLeases = leases.filter((l) => {
        const s = l.lifecycle_status;
        if (
          s === 'submitted' || s === 'under_review' ||
          s === 'concept_submitted' || s === 'concept_under_review'
        ) return true;
        if ((s === 'executed' || s === 'fully_executed') && !(l as any).executed_document_url) return true;
        return false;
      });
      const needsActionCount = needsActionLeases.length;

      // Stat 3: Awaiting Approval.
      // Phase 3: include chain in_concept_review equivalent.
      const awaitingLeases = leases.filter(
        (l) =>
          l.lifecycle_status === 'under_review' ||
          l.lifecycle_status === 'concept_under_review'
      );
      const awaitingCount = awaitingLeases.length;


      // Stat 4: Expiring within 90 days.
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

      setStats([
        {
          label: 'Monthly Rent',
          primary: formatCurrency(monthlyRentSum),
          sub: monthlyRentSub,
          accent: 'default',
          href: '/app/leases?view=active',
        },
        {
          label: 'Needs Action',
          primary: String(needsActionCount),
          sub: needsActionCount === 0 ? 'All clear' : `${needsActionCount} item${needsActionCount !== 1 ? 's' : ''} need attention`,
          accent: needsActionCount > 0 ? 'blue' : 'default',
          href: '/app/leases',
        },
        {
          label: 'Awaiting Approval',
          primary: String(awaitingCount),
          sub: awaitingCount === 0 ? 'none pending' : `${awaitingCount} lease${awaitingCount !== 1 ? 's' : ''} pending`,
          accent: 'orange',
          href: '/app/leases?view=approval',
          disabled: awaitingCount === 0,
        },
        {
          label: 'Expiring \u2264 90 Days',
          primary: String(displayExpiring90Count),
          sub: displayExpiring90Count > 0 ? 'require attention' : 'all clear',
          accent: 'red',
          href: '/app/leases?view=active&expiring=90',
          disabled: displayExpiring90Count === 0,
          onDismiss: displayExpiring90Count > 0 ? () => handleDismiss('90') : undefined,
        },
        {
          label: 'Expiring 91\u2013120 Days',
          primary: String(displayExpiring120Count),
          sub: displayExpiring120Count > 0 ? 'on the horizon' : 'all clear',
          accent: displayExpiring120Count > 0 ? 'orange' : 'default',
          href: '/app/leases?view=active&expiring=120',
          disabled: displayExpiring120Count === 0,
          onDismiss: displayExpiring120Count > 0 ? () => handleDismiss('120') : undefined,
        },
      ]);

      setLoading(false);
    }

    fetchData();
  }, [workspace?.id, refreshKey]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="animate-pulse bg-muted h-20 rounded-lg" />
        ))}
      </div>
    );
  }

  const accentClasses: Record<string, string> = {
    blue: 'border-blue-200 bg-blue-50/50',
    orange: 'border-orange-200 bg-orange-50/50',
    red: 'border-red-200 bg-red-50/50',
    default: '',
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {stats.map((box) => (
        <div
          key={box.label}
          onClick={box.disabled ? undefined : () => navigate(box.href)}
          className={`group rounded-lg border bg-card p-4 transition-shadow ${accentClasses[box.accent ?? 'default']} ${box.disabled ? 'cursor-default' : 'cursor-pointer hover:shadow-md'}`}
        >
          <div className="flex items-start justify-between">
            <p className="text-xs text-muted-foreground">{box.label}</p>
            <div className="flex items-center gap-1">
              {box.onDismiss && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); box.onDismiss!(); }}
                  className="text-muted-foreground/40 hover:text-green-500 transition-colors"
                  title="Mark as seen"
                >
                  <Check className="h-3 w-3" />
                </button>
              )}
              {!box.disabled && (
                <ArrowUpRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0" />
              )}
            </div>
          </div>
          <p className="mt-1 text-xl lg:text-2xl font-semibold tracking-tight truncate tabular-nums">{box.primary}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{box.sub}</p>
        </div>
      ))}
    </div>
  );
}
