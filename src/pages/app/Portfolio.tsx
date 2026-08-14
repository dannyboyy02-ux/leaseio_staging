import { useMemo, type ComponentType, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  CalendarClock,
  ExternalLink,
  Flag,
  Info,
  Layers,
  Lock,
  Scale,
  TrendingUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StatTile } from '@/components/ui/stat-tile';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { isReadOnlyRetention } from '@/config/pricing';
import { supabase } from '@/integrations/supabase/client';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import {
  computeKpis,
  costByDepartment,
  costPerSqftByLocation,
  rentCommitmentForecast,
  toPortfolioLease,
  type PortfolioLease,
} from '@/lib/portfolioIntelligence';
import { buildWatchlist, type Severity, type WatchFlag } from '@/lib/portfolioWatchlist';

// NOTE: the watchlist's generated factual sentences (title/description/value)
// come from src/lib/portfolioWatchlist.ts and remain English — localizing
// those generated strings is tracked as a follow-up.

// Deterministic, brand-derived palette for Cost-by-Department segments; the
// neutral grey is reserved for the "Other" / "Unassigned" buckets.
const DEPT_COLORS = [
  'hsl(213 50% 23%)', // navy
  'hsl(168 76% 32%)', // teal
  'hsl(199 89% 48%)', // sky / info
  'hsl(38 92% 50%)', // amber / warning
  'hsl(262 52% 50%)', // violet
  'hsl(215 16% 47%)', // slate
];
const NEUTRAL = 'hsl(215 14% 60%)';
const deptColor = (dept: string, i: number) =>
  dept === 'Other' || dept === 'Unassigned' ? NEUTRAL : DEPT_COLORS[i % DEPT_COLORS.length];

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

// Thin adapter over the shared <StatTile> (FS-8): Portfolio's tiles are static
// (no accent/click), and `title` maps to StatTile's `valueTitle` — the full
// figure on hover when the compact value truncates in the narrow tile.
function KpiTile({ label, value, sub, title }: { label: string; value: string; sub: string; title?: string }) {
  return (
    <StatTile label={label} labelTitle={label} value={value} sub={sub} valueTitle={title} />
  );
}

// Portfolio's dense, equal-height grid panel — intentionally NOT the shared
// <SectionCard> (it needs a sub caption, flex-1 fill, and tighter p-5). Renamed
// off "SectionCard" to avoid colliding with the shared primitive; its title
// token is aligned to the shared font-display/text-sm/font-medium so section
// headers read the same walking Dashboard -> Portfolio (FS-8 layout review).
function PortfolioPanel({
  title,
  sub,
  icon: Icon,
  right,
  children,
}: {
  title: string;
  sub?: string;
  icon: ComponentType<{ className?: string }>;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="font-display text-sm font-medium">{title}</p>
              {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
            </div>
          </div>
          {right}
        </div>
        <div className="flex-1">{children}</div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function CommitmentForecast({ data }: { data: ReturnType<typeof rentCommitmentForecast> }) {
  const { t, language } = useLanguage();
  const max = Math.max(...data.map((b) => b.contracted + b.uncontracted), 1);
  return (
    <div>
      <div className="flex h-44 items-end gap-3 pt-2">
        {data.map((b) => {
          const ch = (b.contracted / max) * 100;
          const uh = (b.uncontracted / max) * 100;
          return (
            <div key={b.label} className="flex h-full flex-1 flex-col items-center justify-end">
              <span className="mb-1.5 text-[11px] font-semibold text-foreground">
                {b.contracted > 0 ? formatLocalizedCurrency(b.contracted, language, { compact: true }) : '—'}
              </span>
              <div className="flex w-full max-w-[40px] flex-1 flex-col justify-end">
                {uh > 0 && (
                  <div
                    title={t('portfolio.term_ends_uncontracted')}
                    className="rounded-t"
                    style={{
                      height: `${uh}%`,
                      background:
                        'repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.18), hsl(var(--muted-foreground) / 0.18) 4px, hsl(var(--muted-foreground) / 0.06) 4px, hsl(var(--muted-foreground) / 0.06) 8px)',
                      border: '1px dashed hsl(var(--muted-foreground) / 0.4)',
                      borderBottom: 'none',
                    }}
                  />
                )}
                <div
                  style={{ height: `${ch}%`, borderRadius: uh > 0 ? 0 : '4px 4px 0 0', background: 'hsl(var(--chart-contracted))' }}
                />
              </div>
              <span className="mt-2 text-[11px] text-muted-foreground">{b.label}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm" style={{ background: 'hsl(var(--chart-contracted))' }} /> {t('portfolio.contracted_rent_legend')}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm"
            style={{ background: 'hsl(var(--muted-foreground) / 0.12)', border: '1px dashed hsl(var(--muted-foreground) / 0.5)' }}
          />{' '}
          {t('portfolio.term_ends_uncontracted')}
        </span>
      </div>
    </div>
  );
}

function CostByDepartment({ data }: { data: ReturnType<typeof costByDepartment> }) {
  const { t, language } = useLanguage();
  return (
    <div>
      <div className="mb-4 flex h-4 overflow-hidden rounded-full">
        {data.map((s, i) => (
          <div key={s.department} title={`${s.department} · ${formatLocalizedCurrency(s.annualCost, language, { compact: true })}`} style={{ width: `${s.pct}%`, background: deptColor(s.department, i) }} />
        ))}
      </div>
      <div className="flex flex-col gap-2.5">
        {data.map((s, i) => (
          <div key={s.department} className="flex items-center gap-2 text-[13px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: deptColor(s.department, i) }} />
            <span className="flex-1 truncate">{s.department}</span>
            <span className="text-muted-foreground">{formatLocalizedCurrency(s.annualCost, language, { compact: true })}/{t('dashboard.per_year_short')}</span>
            <span className="w-10 text-right font-semibold">{Math.round(s.pct)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CostPerSqft({ data }: { data: ReturnType<typeof costPerSqftByLocation> }) {
  const { t } = useLanguage();
  const scaleMax = Math.max(...data.rows.map((r) => r.ratePerSqft), data.averageRatePerSqft ?? 0, 1) * 1.1;
  return (
    <div className="flex flex-col gap-3.5">
      {data.rows.map((r) => (
        <div key={r.id}>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="truncate text-[13px] font-medium">{r.name}</span>
            <span className="shrink-0 text-xs font-semibold text-muted-foreground">
              {t('portfolio.rate_vs_avg', {
                rate: r.ratePerSqft.toFixed(2),
                delta: `${r.deltaVsAvg > 0 ? '+' : ''}${Math.round(r.deltaVsAvg * 100)}`,
              })}
            </span>
          </div>
          <div className="relative h-2.5 rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${(r.ratePerSqft / scaleMax) * 100}%`,
                background: `hsl(var(${r.position === 'above' ? '--chart-rate-above' : '--chart-rate-below'}))`,
              }}
            />
            {data.averageRatePerSqft != null && (
              <div
                title={t('portfolio.portfolio_average_tooltip', { rate: data.averageRatePerSqft.toFixed(2) })}
                className="absolute -top-0.5 h-3.5 w-0.5 bg-foreground/55"
                style={{ left: `${(data.averageRatePerSqft / scaleMax) * 100}%` }}
              />
            )}
          </div>
        </div>
      ))}
      {data.averageRatePerSqft != null && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-3 w-0.5 bg-foreground/55" /> {t('portfolio.blended_average_legend', { rate: data.averageRatePerSqft.toFixed(2) })}
        </div>
      )}
      {data.excludedCount > 0 && (
        <p className="text-xs text-muted-foreground">{t('portfolio.excluded_no_sqft', { count: data.excludedCount })}</p>
      )}
    </div>
  );
}

const WATCH_ICON: Record<string, ComponentType<{ className?: string }>> = {
  'calendar-clock': CalendarClock,
  calendar: Calendar,
  'arrow-up-right': ArrowUpRight,
  'trending-up': TrendingUp,
};
const WATCH_TONE: Record<Severity, { wrap: string; chip: string }> = {
  warning: { wrap: 'bg-amber-50 dark:bg-amber-950/20', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  info: { wrap: 'bg-sky-50 dark:bg-sky-950/20', chip: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' },
  muted: { wrap: 'bg-muted/50', chip: 'bg-muted text-muted-foreground' },
};

function Watchlist({ flags }: { flags: WatchFlag[] }) {
  const { t } = useLanguage();
  if (flags.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{t('portfolio.watchlist_empty')}</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {flags.map((f) => {
        const Icon = WATCH_ICON[f.icon] ?? Flag;
        const tone = WATCH_TONE[f.severity];
        return (
          <div key={`${f.leaseId}-${f.sourceField}`} className={`flex gap-3 rounded-lg border border-border p-3.5 ${tone.wrap}`}>
            <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${tone.chip}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="text-sm font-semibold">{f.title}</span>
                {f.department && <span className="text-[11px] text-muted-foreground">· {f.department}</span>}
              </div>
              <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{f.description}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end justify-between gap-2">
              <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone.chip}`}>{f.value}</span>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
                <Link to={`/app/leases/${f.leaseId}`}>
                  {t('import.view')} <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Portfolio() {
  const { t, language } = useLanguage();
  const { workspace, canAccessFeature } = useApp();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);

  // KNOWN_ISSUES #46: Portfolio is a Business-tier feature; gate + skip the
  // fetch for Starter. Vault retention views it read-only under the flatten rule.
  const hasBusinessAccess = canAccessFeature('business') || isReadOnlyRetention(workspace?.plan);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['portfolio-intelligence', workspace?.id],
    enabled: !!workspace?.id && hasBusinessAccess,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leases')
        // PostgREST type narrowing requires a literal string.
        .select(
          // rent_schedules embed so getMonthlyRent resolves the CURRENT escalated
          // step — matching the Dashboard/Leases totals (else the same KPI drifts).
          'id, filename, request_title, extracted_json, property_address, landlord_name, requesting_department, region, location, square_footage, current_monthly_rent, monthly_payment, executed_monthly_payment, lease_start, lease_end, escalation_type, escalation_rate, rent_schedules(period_start, period_end, monthly_amount)',
        )
        .eq('workspace_id', workspace!.id)
        .eq('archived', false)
        .in('lifecycle_status', ['executed', 'active', 'fully_executed']);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  // `asOf` fixed per mount so every derived metric shares one clock.
  const asOf = useMemo(() => new Date(), []);
  const leases: PortfolioLease[] = useMemo(
    () =>
      (rows ?? []).map((row) =>
        toPortfolioLease(
          row,
          getPropertyDisplayName(row.extracted_json, row.request_title || row.filename, t('portfolio.property_fallback')),
        ),
      ),
    [rows, t],
  );

  const kpis = useMemo(() => computeKpis(leases, asOf), [leases, asOf]);
  const depts = useMemo(() => costByDepartment(leases), [leases]);
  const locations = useMemo(() => costPerSqftByLocation(leases), [leases]);
  const forecast = useMemo(() => rentCommitmentForecast(leases, asOf), [leases, asOf]);
  const forecastHasData = useMemo(() => forecast.some((b) => b.contracted > 0 || b.uncontracted > 0), [forecast]);
  // `language` in deps: flag copy is baked at build time inside buildWatchlist
  // (module-level i18next t), so a language switch must rebuild the list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const watchlist = useMemo(() => buildWatchlist(leases, { asOf }), [leases, asOf, language]);
  const indexLeases = useMemo(() => leases.filter((l) => l.escalationType === 'index'), [leases]);

  const headerSubtitle =
    leases.length > 0
      ? [
          t('dashboard.leases_count', { count: leases.length }),
          kpis.totalSquareFootage > 0 ? t('portfolio.sqft_value', { value: kpis.totalSquareFootage.toLocaleString() }) : null,
          t('portfolio.markets_count', { count: kpis.marketCount }),
        ]
          .filter(Boolean)
          .join(' · ')
      : t('portfolio.subtitle_default');

  if (!hasBusinessAccess) {
    return (
      <AppLayout>
        <AppHeader title={t('portfolio.title')} subtitle={t('portfolio.subtitle_default')} />
        <PageLayout width="wide">
          <Card variant="ghost" className="mx-auto max-w-2xl border-2 border-dashed border-border">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <Lock className="h-8 w-8 text-muted-foreground" />
              </div>
              <Badge variant="business" className="mb-4">
                {t('common.business_plan')}
              </Badge>
              <h3 className="mb-2 text-lg font-semibold">{t('portfolio.business_gate_title')}</h3>
              <p className="mb-6 max-w-md text-sm text-muted-foreground">
                {t('portfolio.business_gate_desc')}
              </p>
              <Button variant="accent" size="lg" asChild>
                <Link to="/app/settings/account?tab=billing">{t('integrations.upgrade_business')}</Link>
              </Button>
            </CardContent>
          </Card>
        </PageLayout>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader title={t('portfolio.title')} subtitle={headerSubtitle} />
      <PageLayout width="wide">
        {isLoading ? (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            {[...Array(5)].map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-3 h-7 w-24" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : leases.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Layers className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <h3 className="mb-2 text-lg font-semibold text-foreground">{t('portfolio.empty_title')}</h3>
              <p className="max-w-sm text-sm text-muted-foreground">
                {t('portfolio.empty_desc')}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Partial-data banner — surfaces fields the abstraction didn't capture. */}
            {(kpis.missingAreaCount > 0 || kpis.missingRentCount > 0 || kpis.missingEndDateCount > 0) && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {kpis.missingAreaCount > 0 && `${t('portfolio.missing_area', { missing: kpis.missingAreaCount, count: kpis.leaseCount })} `}
                  {kpis.missingRentCount > 0 && `${t('portfolio.missing_rent', { count: kpis.missingRentCount })} `}
                  {kpis.missingEndDateCount > 0 && t('portfolio.missing_end_dates', { count: kpis.missingEndDateCount })}
                </span>
              </div>
            )}

            {/* KPI strip */}
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
              {/* Compact ($15.5M, not $15,485,251) so seven-figure portfolios
                  don't clip the narrow tile; full figure on hover. Matches the
                  compact Rent Forecast chart below. */}
              <KpiTile
                label={t('portfolio.kpi_annual_occupancy')}
                value={formatLocalizedCurrency(kpis.annualOccupancyCost, language, { compact: true })}
                title={formatCurrency(kpis.annualOccupancyCost)}
                sub={t('portfolio.kpi_across_leases', { count: kpis.leaseCount })}
              />
              <KpiTile
                label={t('portfolio.kpi_remaining_commitment')}
                value={formatLocalizedCurrency(kpis.remainingCommitment, language, { compact: true })}
                title={formatCurrency(kpis.remainingCommitment)}
                sub={kpis.contractedThroughYear ? t('portfolio.kpi_undiscounted_through', { year: kpis.contractedThroughYear }) : t('portfolio.kpi_undiscounted_cash')}
              />
              <KpiTile
                label={t('portfolio.kpi_blended_cost')}
                value={formatLocalizedCurrency(kpis.blendedCostPerSqft, language, { cents: true })}
                sub={kpis.blendedCostPerSqft != null ? t('portfolio.kpi_per_sqft_yr') : t('portfolio.kpi_add_sqft')}
              />
              <KpiTile label={t('portfolio.kpi_total_footprint')} value={kpis.totalSquareFootage.toLocaleString()} title={kpis.totalSquareFootage.toLocaleString()} sub={t('portfolio.kpi_sqft_markets', { count: kpis.marketCount })} />
              <KpiTile label={t('portfolio.kpi_avg_term')} value={t('portfolio.years_value', { years: kpis.avgTermRemainingYears.toFixed(1) })} sub={t('portfolio.kpi_weighted_by_rent')} />
            </div>

            {/* Row 1 — forecast + composition */}
            <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-[1.7fr_1fr]">
              <PortfolioPanel title={t('portfolio.forecast_title')} sub={t('portfolio.forecast_sub')} icon={BarChart3} right={<Badge variant="secondary">{t('portfolio.next_5_yrs')}</Badge>}>
                {forecastHasData ? (
                  <CommitmentForecast data={forecast} />
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t('portfolio.forecast_empty')}</p>
                )}
              </PortfolioPanel>
              <PortfolioPanel title={t('portfolio.cost_by_department')} sub={t('portfolio.cost_by_department_sub')} icon={Layers}>
                {depts.length > 0 ? <CostByDepartment data={depts} /> : <p className="text-sm text-muted-foreground">{t('portfolio.no_cost_data')}</p>}
              </PortfolioPanel>
            </div>

            {/* Row 2 — benchmark + watchlist */}
            <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-[1fr_1.4fr]">
              <PortfolioPanel title={t('portfolio.cost_per_sqft_title')} sub={t('portfolio.cost_per_sqft_sub')} icon={Scale}>
                {locations.rows.length > 0 ? (
                  <CostPerSqft data={locations} />
                ) : (
                  <p className="text-sm text-muted-foreground">{t('portfolio.no_sqft_leases')}</p>
                )}
              </PortfolioPanel>
              <PortfolioPanel title={t('portfolio.watchlist_title')} sub={t('portfolio.watchlist_sub')} icon={Flag} right={watchlist.length > 0 ? <Badge variant="secondary">{t('portfolio.items_count', { count: watchlist.length })}</Badge> : undefined}>
                <Watchlist flags={watchlist} />
              </PortfolioPanel>
            </div>

            {/* Index-Lease Disclosure — neutral factual disclosure (kept under the new voice). */}
            {indexLeases.length > 0 && (
              <Card className="border-l-4 border-l-amber-400">
                <CardContent className="p-5">
                  <div className="mb-1 flex items-center gap-2 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                    <p className="text-sm font-semibold">{t('portfolio.index_disclosure_title')}</p>
                  </div>
                  <p className="mb-3 text-xs text-muted-foreground">
                    {t('portfolio.index_disclosure_body')}
                  </p>
                  <div className="space-y-2">
                    {indexLeases.map((l) => (
                      <Link
                        key={l.id}
                        to={`/app/leases/${l.id}`}
                        aria-label={t('portfolio.view_lease_aria', { name: l.propertyName })}
                        className="flex items-center justify-between rounded-md bg-amber-50 px-3 py-2 text-sm hover:bg-amber-100 dark:bg-amber-950/20 dark:hover:bg-amber-950/40"
                      >
                        <span className="truncate">{l.propertyName}</span>
                        <ExternalLink size={14} className="shrink-0 text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Provenance */}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              {t('portfolio.provenance')}
            </div>
          </>
        )}
      </PageLayout>
    </AppLayout>
  );
}
