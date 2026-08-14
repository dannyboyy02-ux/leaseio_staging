import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { SectionCard } from '@/components/ui/section-card';
import { ClipboardList, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatLocalizedCurrency, formatLocalizedDate } from '@/lib/dateFormatters';
import { useLanguage } from '@/contexts/LanguageContext';
import { getMonthlyRent } from '@/lib/leaseCalculations';
import { useApp } from '@/contexts/AppContext';

interface MonthPoint {
  month: string;
  count: number;
  value: number;
}

interface LeaseRow {
  uploaded_at: string | null;
  monthly_payment: number | null;
  executed_monthly_payment: number | null;
  current_monthly_rent: number | null;
  rent_schedules: { period_start: string; period_end: string | null; monthly_amount: number | null }[] | null;
}

export function IntakeTrend() {
  const { t, language } = useLanguage();
  const { workspace } = useApp();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
  const [data, setData] = useState<MonthPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 6);

      const { data: leases } = await supabase
        .from('leases')
        .select('uploaded_at, monthly_payment, executed_monthly_payment, current_monthly_rent, rent_schedules(period_start, period_end, monthly_amount)')
        .eq('workspace_id', workspace.id)
        .gte('uploaded_at', cutoff.toISOString());

      const rows: LeaseRow[] = (leases as LeaseRow[]) ?? [];

      const months: MonthPoint[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const label = formatLocalizedDate(d, language, { month: 'short', year: '2-digit' });
        const monthLeases = rows.filter((l) => {
          if (!l.uploaded_at) return false;
          const ld = new Date(l.uploaded_at);
          return ld.getMonth() === d.getMonth() && ld.getFullYear() === d.getFullYear();
        });
        months.push({
          month: label,
          count: monthLeases.length,
          value: monthLeases.reduce((sum, l) => sum + getMonthlyRent(l as any) * 12, 0),
        });
      }

      setData(months);
      setLoading(false);
    }
    fetchData();
    // `language` is read when building the month labels, so re-run on switch
    // (mirrors CommitmentHistory) — otherwise the axis keeps stale en labels.
  }, [workspace?.id, language]);

  const isEmpty = !loading && data.every((d) => d.count === 0);

  return (
    <SectionCard icon={ClipboardList} title={t('dashboard.intake_trend_title')}>
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-sm text-muted-foreground">{t('dashboard.no_intake_data')}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="intakeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                width={32}
              />
              <Tooltip
                formatter={(val: number, name: string) => {
                  if (name === 'count') return [t('dashboard.leases_count', { count: val }), t('dashboard.leases_label')];
                  if (name === 'value') return [formatCurrency(val), t('dashboard.annual_value')];
                  return [val, name];
                }}
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="count"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#intakeGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
    </SectionCard>
  );
}
