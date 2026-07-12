// OperationsPage — Operational Monitoring Phase 2 admin dashboard.
//
// Three sections per OPERATIONAL_MONITORING_SPEC.md:
//   1. Vendor health — colored bars per (vendor, metric) showing
//      current % of limit, with 30-day sparkline.
//   2. Upcoming renewals — table from vendor_renewal_calendar.
//   3. Recent alerts — last 30 days of vendor_alert_log with
//      acknowledge buttons.
//
// RLS-gated: rows are visible to ops admins only (the
// is_ops_admin helper in 20260509000000_module_monitoring_foundation.sql
// hardcodes the LeaseIO HQ workspace). Non-ops users see an empty
// page.
//
// Recharts sparklines (already in stack via Phase 8 reports). No new
// dependencies.

import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Calendar, Activity } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface UsageSnapshot {
  id: string;
  vendor: string;
  metric: string;
  current_value: number;
  limit_value: number | null;
  pct_of_limit: number | null;
  tier: string | null;
  category: 'soft_quota' | 'hard_cliff' | 'cost_runaway';
  recorded_at: string;
}

interface Renewal {
  id: string;
  vendor: string;
  item: string;
  renewal_date: string;
  amount_estimate: number | null;
  auto_renew: boolean;
  account_url: string | null;
  notes: string | null;
}

interface AlertRow {
  id: string;
  vendor: string;
  metric: string;
  threshold_crossed: 'warn' | 'alert' | 'critical';
  current_value: number | null;
  limit_value: number | null;
  pct_of_limit: number | null;
  upgrade_suggestion: string | null;
  upgrade_url: string | null;
  fired_at: string;
  acknowledged_at: string | null;
}

function pctColor(pct: number | null): string {
  if (pct === null) return 'bg-slate-300';
  if (pct >= 95) return 'bg-red-500';
  if (pct >= 85) return 'bg-orange-500';
  if (pct >= 70) return 'bg-yellow-500';
  return 'bg-green-500';
}

function severityBadge(threshold: AlertRow['threshold_crossed'], t: (k: string) => string) {
  if (threshold === 'critical') return <Badge variant="destructive">{t('operations.severity.critical')}</Badge>;
  if (threshold === 'alert') return <Badge className="bg-orange-500">{t('operations.severity.alert')}</Badge>;
  return <Badge className="bg-yellow-500">{t('operations.severity.warn')}</Badge>;
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export default function OperationsPage() {
  const { t } = useAppTranslation();
  // P2-02: explicit ops-admin gate. The previous design relied solely
  // on RLS — non-ops users hit the route and saw an empty dashboard
  // with no signal that they weren't authorized. Now we ask the DB
  // upfront via the am_i_ops_admin SECURITY DEFINER RPC.
  const [authStatus, setAuthStatus] = useState<'checking' | 'ok' | 'forbidden'>('checking');
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<UsageSnapshot[]>([]);
  const [renewals, setRenewals] = useState<Renewal[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [snapResult, renResult, alertResult] = await Promise.all([
        supabase
          .from('vendor_usage_snapshots' as any)
          .select('id, vendor, metric, current_value, limit_value, pct_of_limit, tier, category, recorded_at')
          .order('recorded_at', { ascending: false })
          .limit(500),
        supabase
          .from('vendor_renewal_calendar' as any)
          .select('id, vendor, item, renewal_date, amount_estimate, auto_renew, account_url, notes')
          .order('renewal_date', { ascending: true })
          .limit(50),
        supabase
          .from('vendor_alert_log' as any)
          .select('id, vendor, metric, threshold_crossed, current_value, limit_value, pct_of_limit, upgrade_suggestion, upgrade_url, fired_at, acknowledged_at')
          .order('fired_at', { ascending: false })
          .limit(50),
      ]);
      setSnapshots((snapResult.data ?? []) as unknown as UsageSnapshot[]);
      setRenewals((renResult.data ?? []) as unknown as Renewal[]);
      setAlerts((alertResult.data ?? []) as unknown as AlertRow[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      const { data, error } = await (supabase as any).rpc('am_i_ops_admin');
      if (error || data !== true) {
        setAuthStatus('forbidden');
        setLoading(false);
        return;
      }
      setAuthStatus('ok');
      await fetchAll();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Group snapshots by (vendor, metric) and find latest + 30-day series
  const latestByMetric = useMemo(() => {
    const map = new Map<string, { latest: UsageSnapshot; series: UsageSnapshot[] }>();
    for (const s of snapshots) {
      const key = `${s.vendor}|${s.metric}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { latest: s, series: [s] });
      } else {
        existing.series.push(s);
        if (new Date(s.recorded_at) > new Date(existing.latest.recorded_at)) {
          existing.latest = s;
        }
      }
    }
    // Sort each series chronologically for sparkline rendering
    for (const v of map.values()) {
      v.series.sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
    }
    return Array.from(map.values()).sort((a, b) => {
      const va = a.latest.vendor.localeCompare(b.latest.vendor);
      return va !== 0 ? va : a.latest.metric.localeCompare(b.latest.metric);
    });
  }, [snapshots]);

  const acknowledge = async (alertId: string) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase
      .from('vendor_alert_log' as any)
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: user.id })
      .eq('id', alertId);
    if (error) {
      toast.error(t('operations.acknowledge_failed', { message: error.message }));
      return;
    }
    setAlerts((prev) => prev.map((a) => a.id === alertId
      ? { ...a, acknowledged_at: new Date().toISOString() }
      : a));
    toast.success(t('operations.acknowledged'));
  };

  const upcomingRenewals = renewals.filter((r) => daysUntil(r.renewal_date) <= 60 && daysUntil(r.renewal_date) >= 0);

  if (authStatus === 'forbidden') {
    return (
      <AppLayout>
        <AppHeader title={t('operations.title')} />
        <div className="p-6 max-w-2xl">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertCircle className="h-4 w-4 text-destructive" />
                {t('operations.forbidden_title')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {t('operations.forbidden_desc')}
              </p>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title={t('operations.title')}
        subtitle={t('operations.subtitle')}
      />
      <div className="p-6 space-y-6 max-w-7xl">
        {(authStatus === 'checking' || loading) && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('workspace.watchlist.loading')}
          </div>
        )}

        {/* Section 1: Vendor health */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" /> {t('operations.vendor_health')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {latestByMetric.length === 0 && !loading && (
              <p className="text-sm text-muted-foreground">
                {t('operations.no_snapshots')}
              </p>
            )}
            <ul className="space-y-3">
              {latestByMetric.map(({ latest, series }) => {
                const pct = latest.pct_of_limit;
                return (
                  <li key={latest.id} className="border rounded-md p-3">
                    <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-sm font-medium">{latest.vendor}</span>
                        <span className="text-sm text-muted-foreground">·</span>
                        <span className="font-mono text-sm">{latest.metric}</span>
                        {latest.tier && <Badge variant="outline" className="text-[10px]">{latest.tier}</Badge>}
                        <Badge variant="outline" className="text-[10px]">{latest.category}</Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(latest.recorded_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <div className="h-2 w-full bg-slate-200 rounded overflow-hidden">
                          <div
                            className={`h-full ${pctColor(pct)}`}
                            style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                          />
                        </div>
                        <div className="flex items-baseline justify-between mt-1 text-xs text-muted-foreground">
                          <span>{latest.current_value.toLocaleString()} / {latest.limit_value?.toLocaleString() ?? t('operations.no_cap')}</span>
                          <span>{pct !== null ? `${pct}%` : t('operations.no_limit')}</span>
                        </div>
                      </div>
                      {series.length > 1 && (
                        <div className="w-32 h-10">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={series.map((s) => ({ pct: s.pct_of_limit ?? 0 }))}>
                              <YAxis hide domain={[0, 100]} />
                              <Line type="monotone" dataKey="pct" stroke="#64748b" strokeWidth={1.5} dot={false} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        {/* Section 2: Upcoming renewals */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-4 w-4" /> {t('operations.upcoming_renewals')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {upcomingRenewals.length === 0 && !loading && (
              <p className="text-sm text-muted-foreground">
                {t('operations.no_renewals')}
              </p>
            )}
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {upcomingRenewals.map((r) => {
                  const days = daysUntil(r.renewal_date);
                  const tone = days <= 7 ? 'text-red-700 font-semibold' : days <= 30 ? 'text-amber-700' : 'text-slate-700';
                  return (
                    <tr key={r.id}>
                      <td className="py-2 pr-4 font-mono text-xs">{r.vendor}</td>
                      <td className="py-2 pr-4">{r.item}</td>
                      <td className={`py-2 pr-4 ${tone}`}>{r.renewal_date} · {t('operations.days_short', { count: days })}</td>
                      <td className="py-2 pr-4">{r.amount_estimate !== null ? `$${r.amount_estimate}` : ''}</td>
                      <td className="py-2 pr-4">{r.auto_renew ? <Badge variant="outline">{t('operations.auto')}</Badge> : <Badge variant="destructive">{t('operations.manual')}</Badge>}</td>
                      <td className="py-2 text-right">
                        {r.account_url && <a href={r.account_url} target="_blank" rel="noreferrer" className="text-primary underline text-xs">{t('operations.manage')}</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Section 3: Recent alerts */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> {t('operations.recent_alerts')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {alerts.length === 0 && !loading && (
              <p className="text-sm text-muted-foreground">
                {t('operations.no_alerts')}
              </p>
            )}
            <ul className="space-y-2">
              {alerts.map((a) => (
                <li
                  key={a.id}
                  className={`border rounded-md p-3 flex items-start justify-between gap-3 ${a.acknowledged_at ? 'opacity-60' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      {severityBadge(a.threshold_crossed, t)}
                      <span className="font-mono text-sm">{a.vendor}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="font-mono text-sm">{a.metric}</span>
                      <span className="text-xs text-muted-foreground">{new Date(a.fired_at).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {a.current_value} / {a.limit_value ?? t('operations.no_cap')}{a.pct_of_limit !== null ? ` · ${a.pct_of_limit}%` : ''}
                    </p>
                    {a.upgrade_suggestion && (
                      <p className="text-xs mt-1">{a.upgrade_suggestion}{a.upgrade_url && <> — <a href={a.upgrade_url} target="_blank" rel="noreferrer" className="text-primary underline">{t('operations.link')}</a></>}</p>
                    )}
                  </div>
                  {a.acknowledged_at ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-1" />
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => acknowledge(a.id)}>{t('operations.acknowledge')}</Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
