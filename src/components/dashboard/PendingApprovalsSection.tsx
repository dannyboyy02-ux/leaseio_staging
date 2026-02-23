import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, ChevronRight, Upload, CheckSquare, FileSearch, Lock } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

interface PendingItem {
  id: string;
  title: string;
  description: string;
  href: string;
  urgency: 'normal' | 'high';
  icon: React.ComponentType<{ className?: string }>;
}

export function PendingApprovalsSection() {
  const { workspace } = useApp();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-pending-actions', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leases')
        .select('id, filename, lifecycle_status, uploaded_at')
        .eq('workspace_id', workspace!.id)
        .in('lifecycle_status', ['submitted', 'under_review', 'approved', 'executed'])
        .order('uploaded_at', { ascending: false })
        .limit(12);

      if (error) throw error;
      return data || [];
    },
  });

  const items: PendingItem[] = useMemo(() => {
    const leases = data || [];
    const output: PendingItem[] = [];

    for (const lease of leases) {
      const name = lease.filename || 'Unnamed lease';

      if (lease.lifecycle_status === 'submitted') {
        output.push({
          id: `submitted-${lease.id}`,
          title: name,
          description: 'Submitted — awaiting abstraction and review',
          href: `/app/leases/${lease.id}`,
          urgency: 'normal',
          icon: FileSearch,
        });
      }

      if (lease.lifecycle_status === 'under_review') {
        output.push({
          id: `review-${lease.id}`,
          title: name,
          description: 'Under review — approval decision required',
          href: `/app/leases/${lease.id}`,
          urgency: 'high',
          icon: CheckSquare,
        });
      }

      if (lease.lifecycle_status === 'approved') {
        output.push({
          id: `approved-${lease.id}`,
          title: name,
          description: 'Approved — upload the executed document',
          href: `/app/leases/${lease.id}`,
          urgency: 'high',
          icon: Upload,
        });
      }

      if (lease.lifecycle_status === 'executed') {
        output.push({
          id: `executed-${lease.id}`,
          title: name,
          description: 'Executed — complete term review and lock model',
          href: `/app/leases/${lease.id}`,
          urgency: 'normal',
          icon: Lock,
        });
      }
    }

    return output.slice(0, 6);
  }, [data]);

  // Don't render anything if no pending items
  if (!isLoading && items.length === 0) return null;

  return (
    <Card className="border-l-4 border-l-warning bg-warning/5 border-warning/30 shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2.5 text-base">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-warning text-warning-foreground shrink-0">
            <AlertTriangle className="h-4 w-4" />
          </div>
          Action Required
          {!isLoading && (
            <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-warning px-1.5 text-[11px] font-bold text-warning-foreground">
              {items.length}
            </span>
          )}
        </CardTitle>
        <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
          <Link to="/app/leases">View All <ChevronRight className="h-3.5 w-3.5 ml-1" /></Link>
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <Link
                key={item.id}
                to={item.href}
                className="flex items-center justify-between rounded-lg border border-warning/20 bg-background p-3 transition-colors hover:border-warning/50 hover:bg-warning/5 group"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.description}</p>
                  </div>
                </div>
                <div className="ml-3 flex items-center gap-2 shrink-0">
                  {item.urgency === 'high' && (
                    <Badge variant="destructive" className="text-[10px]">Now</Badge>
                  )}
                  <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
