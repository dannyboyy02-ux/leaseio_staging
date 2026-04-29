import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import { getCurrentMonthlyRent } from '@/lib/leaseCalculations';

interface StatBox {
  label: string;
  primary: string;
  sub: string;
  accent?: 'blue' | 'orange' | 'red' | 'default';
  href: string;
}

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

const formatCurrencyDecimals = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export function SummaryStrip() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [stats, setStats] = useState<StatBox[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) {
        setLoading(false);
        return;
      }

      const { data: leases } = await supabase
        .from('leases')
        .select(
          'lifecycle_status, executed_monthly_payment, current_monthly_rent, monthly_payment, executed_expiry_date, lease_end, square_footage, executed_document_url, ' +
          'rent_schedules(period_start, period_end, monthly_amount)'
        )
        .eq('workspace_id', workspace.id);

      if (!leases) {
        setLoading(false);
        return;
      }

      const now = Date.now();
      const ninetyDaysMs    = 90  * 24 * 60 * 60 * 1000;
      const oneTwentyDaysMs = 120 * 24 * 60 * 60 * 1000;

      // Stat 1: Monthly Rent (active + executed leases) + weighted avg $/sqft
      const portfolioLeases = leases.filter(
        (l) => l.lifecycle_status === 'active' || l.lifecycle_status === 'executed'
      );
      const monthlyRentSum = portfolioLeases.reduce(
        (sum, l) => sum + getCurrentMonthlyRent((l as any).rent_schedules, l.executed_monthly_payment, l.current_monthly_rent, l.monthly_payment),
        0
      );

      const leasesWithSqft = portfolioLeases.filter((l) => Number(l.square_footage ?? 0) > 0);
      const totalMonthlyRent = leasesWithSqft.reduce(
        (sum, l) => sum + getCurrentMonthlyRent((l as any).rent_schedules, l.executed_monthly_payment, l.current_monthly_rent, l.monthly_payment),
        0
      );
      const totalSqft = leasesWithSqft.reduce((sum, l) => sum + Number(l.square_footage ?? 0), 0);
      const weightedAvgPerSqft = totalSqft > 0 ? totalMonthlyRent / totalSqft : null;

      const monthlyRentSub =
        weightedAvgPerSqft !== null
          ? `Avg ${formatCurrencyDecimals(weightedAvgPerSqft)}/sqft`
          : `${portfolioLeases.length} portfolio lease${portfolioLeases.length !== 1 ? 's' : ''}`;

      // Stat 2: Needs Action — leases requiring human attention
      const needsActionLeases = leases.filter((l) => {
        if (l.lifecycle_status === 'submitted' || l.lifecycle_status === 'under_review') return true;
        if (l.lifecycle_status === 'executed' && !(l as any).executed_document_url) return true;
        return false;
      });
      const needsActionCount = needsActionLeases.length;

      // Stat 3: Awaiting Approval
      const awaitingLeases = leases.filter((l) => l.lifecycle_status === 'under_review');
      const awaitingCount = awaitingLeases.length;


      // Stat 4: Expiring within 90 days
      const expiringStatuses = ['active', 'executed'];
      const expiringLeases = leases.filter((l) => {
        if (!expiringStatuses.includes(l.lifecycle_status ?? '')) return false;
        const expiryStr = l.executed_expiry_date ?? l.lease_end;
        if (!expiryStr) return false;
        const expiryTime = new Date(expiryStr).getTime();
        return expiryTime > now && expiryTime - now <= ninetyDaysMs;
      });
      const expiringCount = expiringLeases.length;

      // Stat 5: Expiring 91–120 days
      const expiring91to120Leases = leases.filter((l) => {
        if (!expiringStatuses.includes(l.lifecycle_status ?? '')) return false;
        const expiryStr = l.executed_expiry_date ?? l.lease_end;
        if (!expiryStr) return false;
        const diff = new Date(expiryStr).getTime() - now;
        return diff > ninetyDaysMs && diff <= oneTwentyDaysMs;
      });
      const expiring91to120Count = expiring91to120Leases.length;

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
        },
        {
          label: 'Expiring \u2264 90 Days',
          primary: String(expiringCount),
          sub: expiringCount > 0 ? 'require attention' : 'all clear',
          accent: 'red',
          href: '/app/leases?view=active&expiring=90',
        },
        {
          label: 'Expiring 91\u2013120 Days',
          primary: String(expiring91to120Count),
          sub: expiring91to120Count > 0 ? 'on the horizon' : 'all clear',
          accent: expiring91to120Count > 0 ? 'orange' : 'default',
          href: '/app/leases?view=active&expiring=120',
        },
      ]);

      setLoading(false);
    }

    fetchData();
  }, [workspace?.id]);

  if (loading) {
    return (
      <div className="grid grid-cols-5 gap-4">
        {[1, 2, 3, 4].map((i) => (
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
    <div className="grid grid-cols-5 gap-4">
      {stats.map((box) => (
        <div
          key={box.label}
          onClick={() => navigate(box.href)}
          className={`group rounded-lg border bg-card p-4 cursor-pointer hover:shadow-md transition-shadow ${accentClasses[box.accent ?? 'default']}`}
        >
          <div className="flex items-start justify-between">
            <p className="text-xs text-muted-foreground">{box.label}</p>
            <ArrowUpRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0" />
          </div>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{box.primary}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{box.sub}</p>
        </div>
      ))}
    </div>
  );
}
