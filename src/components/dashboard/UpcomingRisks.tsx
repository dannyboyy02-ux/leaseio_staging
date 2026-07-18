import { useEffect, useState } from 'react';
import { AlertTriangle, Shield } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import { getMonthlyRent } from '@/lib/leaseCalculations';

interface Risk {
  leaseId: string;
  title: string;
  riskType: 'auto_renewal' | 'expiring' | 'cpi_escalation';
  /** i18n key for the risk badge label, translated at render. */
  label: string;
  badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline';
  badgeClass: string;
  daysRemaining: number | null;
  annualRent: number;
}

type FilterType = 'all' | 'auto_renewal' | 'expiring' | 'cpi_escalation';

// Chip labels are i18n keys, translated at render.
const CHIP_LABEL_KEYS: Record<FilterType, string> = {
  all: 'dashboard.filter_all',
  auto_renewal: 'dashboard.filter_auto_renew',
  expiring: 'dashboard.filter_expiring',
  cpi_escalation: 'dashboard.filter_cpi',
};

export function UpcomingRisks() {
  const { t, language } = useLanguage();
  const { workspace } = useApp();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
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
        // PostgREST type narrowing requires a literal string — see note in useNeedsAction.
        .select('id, request_title, filename, lease_end, executed_expiry_date, renewal_options, escalation_type, rent_escalation_type, executed_monthly_payment, current_monthly_rent, monthly_payment, rent_schedules(period_start, period_end, monthly_amount)')
        .eq('workspace_id', workspace.id)
        // Phase 3: include chain executed equivalent (active is identical).
        .in('lifecycle_status', ['active', 'executed', 'fully_executed']);

      if (!leases) {
        setLoading(false);
        return;
      }

      const now = Date.now();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const oneEightyDaysMs = 180 * 24 * 60 * 60 * 1000;

      const derived: Risk[] = [];

      for (const lease of leases) {
        const title = lease.request_title ?? lease.filename ?? t('dashboard.unnamed_lease');
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

        const annualRent = getMonthlyRent(lease as any) * 12;

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
            label: 'dashboard.risk_optout',
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
            label: 'dashboard.risk_expiring',
            badgeVariant: 'destructive',
            badgeClass: 'bg-red-100 text-red-700',
            daysRemaining: daysToExpiry,
            annualRent,
          });
        }

        // CPI is a standing attribute, not a time-sensitive event, so it can
        // clutter "Upcoming Risks" indefinitely — only surface it for leases
        // that are still current (skip already-expired ones).
        if (isCpi && (daysToExpiry === null || daysToExpiry >= 0)) {
          derived.push({
            leaseId: lease.id,
            title,
            riskType: 'cpi_escalation',
            label: 'dashboard.risk_cpi',
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

      // Store the full sorted list; the render caps each VIEW at 5
      // (filteredRisks.slice(0, 5)). Pre-truncating here hid every risk past
      // the global top 5 from the category filters — e.g. "Auto-Renew" could
      // report "none" while such a lease approached its opt-out.
      setRisks(sorted);
      setLoading(false);
    }

    fetchData();
    // `language` re-runs the fetch on switch so the translated title
    // fallbacks rebuild (mirrors IntakeTrend/CommitmentHistory).
  }, [workspace?.id, language]);

  const filteredRisks = activeFilter === 'all' ? risks : risks.filter((r) => r.riskType === activeFilter);

  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {t('dashboard.upcoming_risks')}
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
            <span>{t('dashboard.no_immediate_risks')}</span>
          </div>
        ) : (
          <div>
            <div className="flex gap-1 flex-wrap mb-3">
              {(Object.keys(CHIP_LABEL_KEYS) as FilterType[]).map((f) => (
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
                  {t(CHIP_LABEL_KEYS[f])}
                </button>
              ))}
            </div>
            {filteredRisks.length === 0 ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Shield className="h-4 w-4 shrink-0" />
                <span>{t('dashboard.no_type_risks', { type: t(CHIP_LABEL_KEYS[activeFilter]).toLowerCase() })}</span>
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
                      <span className="block text-xs text-muted-foreground">{t('dashboard.days')}</span>
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
                    {t(risk.label)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatCurrency(risk.annualRent)}/{t('dashboard.per_year_short')}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
