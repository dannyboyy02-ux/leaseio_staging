import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { TrendingUp, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

interface MonthPoint {
  month: string;
  commitment: number;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function CommitmentHistory() {
  const { workspace } = useApp();
  const [data, setData] = useState<MonthPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const { data: leases } = await supabase
        .from('leases')
        .select('calc_total_commitment, lease_start')
        .eq('workspace_id', workspace.id)
        .filter('calc_total_commitment', 'not.is', 'null');

      if (!leases?.length) { setLoading(false); return; }

      const byMonth: Record<string, number> = {};
      leases.forEach((l) => {
        if (!l.lease_start) return;
        const d = new Date(l.lease_start);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        byMonth[key] = (byMonth[key] || 0) + Number(l.calc_total_commitment);
      });

      const sorted = Object.entries(byMonth)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([key, commitment]) => ({
          month: new Date(key + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
          commitment,
        }));

      setData(sorted);
      setLoading(false);
    }
    fetchData();
  }, [workspace?.id]);

  // Hide entirely when there's no data — don't show an empty card to new users
  if (!loading && data.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Total Commitment History</CardTitle>
            <CardDescription>Lease commitments grouped by commencement month</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="commitGradient" x1="0" y1="0" x2="0" y2="1">
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
                tickFormatter={formatCompact}
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                width={56}
              />
              <Tooltip
                formatter={(val: number) => [
                  `$${val.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
                  'Commitment',
                ]}
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="commitment"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#commitGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
