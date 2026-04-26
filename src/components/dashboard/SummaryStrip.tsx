import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';

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
          'lifecycle_status, executed_monthly_payment, current_monthly_rent, monthly_payment, executed_expiry_date, lease_end, square_footage'
        )
        .eq('workspace_id', workspace.id);

      if (!leases) {
        setLoading(false);
        return;
      }

      const now = Date.now();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

      // Stat 1: Monthly Rent (active + executed leases) + weighted avg $/sqft
      const portfolioLeases = leases.filter(
        (l) => l.lifecycle_status === 'active' || l.lifecycle_status === 'executed'
      );
      const monthlyRentSum = portfolioLeases.reduce(
        (sum, l) =>
          sum +
          (l.executed_monthly_payment ?? l.current_monthly_rent ?? l.monthly_payment ?? 0),
        0
      );

      const leasesWithSqft = portfolioLeases.filter((l) => Number(l.square_footage ?? 0) > 0);
      const totalAnnualRent = leasesWithSqft.reduce(
        (sum, l) =>
          sum +
          (l.executed_monthly_payment ?? l.current_monthly_rent ?? l.monthly_payment ?? 0) * 12,
        0
      );
      const totalSqft = leasesWithSqft.reduce((sum, l) => sum + Number(l.square_footage ?? 0), 0);
      const weightedAvgPerSqft = totalSqft > 0 ? totalAnnualRent / totalSqft : null;

      const monthlyRentSub =
        weightedAvgPerSqft !== null
          ? `Avg ${formatCurrency(weightedAvgPerSqft)}/sqft`
          : `${portfolioLeases.length} portfolio lease${portfolioLeases.length !== 1 ? 's' : ''}`;

      // Stat 2: Pipeline Value
      const pipelineStatuses = ['submitted', 'under_review', 'approved'];
      const pipelineLeases = leases.filter((l) =>
        pipelineStatuses.includes(l.lifecycle_status ?? '')
      );
      const pipelineValue = pipelineLeases.reduce(
        (sum, l) => sum + (l.monthly_payment ?? 0) * 12,
        0
      );

      // Stat 3: Awaiting Approval
      const awaitingLeases = leases.filter((l) => l.lifecycle_status === 'under_review');
      const awaitingCount = awaitingLeases.length;
      const awaitingAnnualValue = awaitingLeases.reduce(
        (sum, l) => sum + (l.monthly_payment ?? 0) * 12,
        0
      );

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
      const expiringAnnualRent = expiringLeases.reduce(
        (sum, l) =>
          sum +
          (l.executed_monthly_payment ?? l.current_monthly_rent ?? l.monthly_payment ?? 0) * 12,
        0
      );

      setStats([
        {
          label: 'Monthly Rent',
          primary: formatCurrency(monthlyRentSum),
          sub: monthlyRentSub,
          accent: 'default',
          href: '/app/leases?view=active',
        },
        {
          label: 'Pipeline Value',
          primary: formatCurrency(pipelineValue),
          sub: pipelineLeases.length === 0
            ? 'No active requests'
            : `${pipelineLeases.length} lease${pipelineLeases.length !== 1 ? 's' : ''} in progress`,
          accent: 'blue',
          href: '/app/leases?view=approval',
        },
        {
          label: 'Awaiting Approval',
          primary: String(awaitingCount),
          sub: `${formatCurrency(awaitingAnnualValue)} annual value`,
          accent: 'orange',
          href: '/app/leases?view=approval',
        },
        {
          label: 'Expiring \u2264 90 Days',
          primary: String(expiringCount),
          sub: `${formatCurrency(expiringAnnualRent)} annual rent`,
          accent: 'red',
          href: '/app/leases?view=active&expiring=90',
        },
      ]);

      setLoading(false);
    }

    fetchData();
  }, [workspace?.id]);

  if (loading) {
    return (
      <div className="grid grid-cols-4 gap-4">
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
    <div className="grid grid-cols-4 gap-4">
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
