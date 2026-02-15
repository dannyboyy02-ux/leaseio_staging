import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { BarChart3 } from 'lucide-react';
import { useApp } from '@/contexts/AppContext';

const STATUS_ORDER = ['requested', 'negotiating', 'pending_review', 'executed', 'active'] as const;

const STATUS_LABELS: Record<(typeof STATUS_ORDER)[number], string> = {
  requested: 'Requested',
  negotiating: 'Negotiating',
  pending_review: 'Pending Review',
  executed: 'Executed',
  active: 'Active',
};

export function QuickStats() {
  const { workspace } = useApp();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-pipeline-summary', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leases')
        .select('id, lifecycle_status')
        .eq('workspace_id', workspace!.id);

      if (error) throw error;

      const counts = STATUS_ORDER.reduce((acc, status) => {
        acc[status] = 0;
        return acc;
      }, {} as Record<(typeof STATUS_ORDER)[number], number>);

      for (const lease of data || []) {
        if (lease.lifecycle_status && lease.lifecycle_status in counts) {
          counts[lease.lifecycle_status as (typeof STATUS_ORDER)[number]] += 1;
        }
      }

      return counts;
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          Pipeline Summary
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STATUS_ORDER.map((status) => (
              <Skeleton key={status} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STATUS_ORDER.map((status) => (
              <Link
                key={status}
                to={`/app/leases?status=${status}`}
                className="rounded-lg border bg-card p-3 transition-colors hover:border-primary/40"
              >
                <p className="text-xs text-muted-foreground">{STATUS_LABELS[status]}</p>
                <div className="mt-2 flex items-end justify-between">
                  <p className="text-2xl font-semibold">{data?.[status] ?? 0}</p>
                  <Badge variant="secondary" className="text-[10px]">view</Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
