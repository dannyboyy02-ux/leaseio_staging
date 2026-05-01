import { useEffect, useState } from 'react';
import { AlertTriangle, Shield } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import { getCurrentMonthlyRent } from '@/lib/leaseCalculations';

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

interface Risk {
  leaseId: string;
  title: string;
  riskType: 'auto_renewal' | 'expiring' | 'cpi_escalation';
  label: string;
  badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline';
  badgeClass: string;
  daysRemaining: number | null;
  annualRent: number;
}

type FilterType = 'all' | 'auto_renewal' | 'expiring' | 'cpi_escalation';

const CHIP_LABELS: Record<FilterType, string> = {
  all: 'All',
  auto_renewal: 'Auto-Renew',
  expiring: 'Expiring',
  cpi_escalation: 'CPI',
};

export function UpcomingRisks() {
  const { workspace } = useApp();
  const [risks, setRisks] = useState<Risk[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) {
        setLoading(false);
        return;
      }

      const { data: leases } = await supabase
        .from('leases')
        .select(
          'id, request_title, filename, lease_end, executed_expiry_date, renewal_options, escalation_type, rent_escalation_type, executed_monthly_payment, current_monthly_rent, monthly_payment, ' +
          'rent_schedules(period_start, period_end, monthly_amount)'
        )
        .eq('workspace_id', workspace.id)
        .in('lifecycle_status', ['active', 'executed']);

      if (!leases) {
        setLoading(false);
        return;
      }

      const now = Date.now();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const oneEightyDaysMs = 180 * 24 * 60 * 60 * 1000;

      const derived: Risk[] = [];

      for (const lease of leases) {
        const title = lease.request_title ?? lease.filename ?? 'Unnamed lease';
        const expiryStr = lease.executed_expiry_date ?? lease.lease_end;
        const expiryDate = expiryStr ? new Date(expiryStr) : null;
        const daysToExpiry =
          expiryDate !== null
            ? Math.floor((expiryDate.getTime() - now) / 86400000)
            : null;

        const hasRenewal =
          !!lease.renewal_options && lease.renewal_options.trim() !== '';

        const escalationType = (lease.escalation_type ?? '').toLowerCase();
        const rentEscalationType = (lease.rent_escalation_type ?? '').toLowerCase();
        const isCpi =
          ['index', 'cpi'].includes(escalationType) ||
          ['index', 'cpi'].includes(rentEscalationType);

        const annualRent = getCurrentMonthlyRent(
          (lease as any).rent_schedules,
          lease.executed_monthly_payment,
          lease.current_monthly_rent,
          lease.monthly_payment,
        ) * 12;

        if (
          hasRenewal &&
          daysToExpiry !== null &&
          daysToExpiry <= 180 &&
          expiryDate !== null &&
          expiryDate.getTime() - now <= oneEightyDaysMs
        ) {
          derived.push({
            leaseId: lease.id,
            title,
            riskType: 'auto_renewal',
            label: 'Opt-out window closing',
            badgeVariant: 'default',
            badgeClass: 'bg-indigo-100 text-indigo-700',
            daysRemaining: daysToExpiry,
            annualRent,
          });
        }

        if (
          !hasRenewal &&
          daysToExpiry !== null &&
          daysToExpiry <= 90 &&
          expiryDate !== null &&
          expiryDate.getTime() - now <= ninetyDaysMs
        ) {
          derived.push({
            leaseId: lease.id,
            title,
            riskType: 'expiring',
            label: 'Lease expiring',
            badgeVariant: 'destructive',
            badgeClass: 'bg-red-100 text-red-700',
            daysRemaining: daysToExpiry,
            annualRent,
          });
        }

        if (isCpi) {
          derived.push({
            leaseId: lease.id,
            title,
            riskType: 'cpi_escalation',
            label: 'CPI projection not applied',
            badgeVariant: 'secondary',
            badgeClass: 'bg-amber-100 text-amber-700',
            daysRemaining: null,
            annualRent,
          });
        }
      }

      // Sort: items with daysRemaining ascending first, then CPI items (daysRemaining null)
      const sorted = derived.sort((a, b) => {
        if (a.daysRemaining !== null && b.daysRemaining !== null) {
          return a.daysRemaining - b.daysRemaining;
        }
        if (a.daysRemaining !== null) return -1;
        if (b.daysRemaining !== null) return 1;
        return 0;
      });

      // Cap at 5 to match the dashboard's tight density (Recent Activity = 3,
      // AI Extractions = 4). Beyond this users go to the dedicated Risks
      // surfaces (Reports / per-lease Risks tab) for the full list.
      setRisks(sorted.slice(0, 5));
      setLoading(false);
    }

    fetchData();
  }, [workspace?.id]);

  const filteredRisks = activeFilter === 'all' ? risks : risks.filter((r) => r.riskType === activeFilter);

  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Upcoming Risks
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse bg-muted h-14 rounded" />
            ))}
          </div>
        ) : risks.length === 0 ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Shield className="h-4 w-4 shrink-0" />
            <span>No immediate risks detected · monitoring renewals, escalations, expirations</span>
          </div>
        ) : (
          <div>
            <div className="flex gap-1 flex-wrap mb-3">
              {(Object.keys(CHIP_LABELS) as FilterType[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setActiveFilter(f)}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                    activeFilter === f
                      ? 'bg-foreground text-background border-foreground'
                      : 'border-border text-muted-foreground hover:border-foreground/50',
                  )}
                >
                  {CHIP_LABELS[f]}
                </button>
              ))}
            </div>
            {filteredRisks.length === 0 ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Shield className="h-4 w-4 shrink-0" />
                <span>No {CHIP_LABELS[activeFilter].toLowerCase()} risks detected</span>
              </div>
            ) : filteredRisks.slice(0, 5).map((risk, index) => (
              <div
                key={`${risk.leaseId}-${risk.riskType}-${index}`}
                className="flex items-center gap-3 py-2 border-b last:border-0"
              >
                <div className="w-10 text-center shrink-0">
                  {risk.daysRemaining !== null ? (
                    <>
                      <span className="text-lg font-bold leading-none block">
                        {risk.daysRemaining}
                      </span>
                      <span className="block text-xs text-muted-foreground">days</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">&mdash;</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{risk.title}</p>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${risk.badgeClass}`}
                  >
                    {risk.label}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatCurrency(risk.annualRent)}/yr
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
