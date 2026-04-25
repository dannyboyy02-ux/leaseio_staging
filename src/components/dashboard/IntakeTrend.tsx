import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClipboardList, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useNavigate } from 'react-router-dom';

interface MonthPoint {
  month: string;
  count: number;
  value: number;
}

interface LeaseRow {
  uploaded_at: string | null;
  monthly_payment: number | null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

export function IntakeTrend() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<MonthPoint[]>([]);
  const [loading, setLoading] = useState(true);

  // navigate retained for future drill-down use
  void navigate;

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 6);

      const { data: leases } = await supabase
        .from('leases')
        .select('uploaded_at, monthly_payment')
        .eq('workspace_id', workspace.id)
        .gte('uploaded_at', cutoff.toISOString());

      const rows: LeaseRow[] = (leases as LeaseRow[]) ?? [];

      const months: MonthPoint[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        const monthLeases = rows.filter((l) => {
          if (!l.uploaded_at) return false;
          const ld = new Date(l.uploaded_at);
          return ld.getMonth() === d.getMonth() && ld.getFullYear() === d.getFullYear();
        });
        months.push({
          month: label,
          count: monthLeases.length,
          value: monthLeases.reduce((sum, l) => sum + (l.monthly_payment ?? 0) * 12, 0),
        });
      }

      setData(months);
      setLoading(false);
    }
    fetchData();
  }, [workspace?.id]);

  const isEmpty = !loading && data.every((d) => d.count === 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ClipboardList className="h-4 w-4" />
          New Lease Intake — Last 6 Months
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          <div className="flex items-center justify-center h-48">
            <p className="text-sm text-muted-foreground">No lease intake data yet.</p>
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
                  if (name === 'count') return [`${val} lease${val !== 1 ? 's' : ''}`, 'Leases'];
                  if (name === 'value') return [formatCurrency(val), 'Annual Value'];
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
      </CardContent>
    </Card>
  );
}
