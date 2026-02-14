import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ClipboardList, Clock3, FileSearch, Upload } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

interface PendingItem {
  id: string;
  title: string;
  description: string;
  href: string;
  urgency: 'normal' | 'high';
}

export function PendingApprovalsSection() {
  const { workspace } = useApp();

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-pending-actions', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leases')
        .select('id, request_title, lifecycle_status, storage_path, uploaded_at')
        .eq('workspace_id', workspace!.id)
        .in('lifecycle_status', ['requested', 'pending_review', 'executed'])
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
      if (lease.lifecycle_status === 'requested') {
        output.push({
          id: `requested-${lease.id}`,
          title: lease.request_title || 'New lease request',
          description: 'New request needs finance acknowledgment',
          href: `/app/leases/${lease.id}`,
          urgency: 'normal',
        });
      }

      if (lease.lifecycle_status === 'pending_review') {
        output.push({
          id: `review-${lease.id}`,
          title: lease.request_title || 'Document pending review',
          description: lease.storage_path
            ? 'Executed document uploaded and waiting for review'
            : 'Awaiting executed document upload',
          href: `/app/leases/${lease.id}`,
          urgency: 'high',
        });
      }

      if (lease.lifecycle_status === 'executed') {
        output.push({
          id: `executed-${lease.id}`,
          title: lease.request_title || 'Executed lease ready',
          description: 'Lease can be moved to active repository',
          href: `/app/leases/${lease.id}`,
          urgency: 'normal',
        });
      }
    }

    return output.slice(0, 6);
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-warning" />
          Pending Actions
        </CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/app/leases?view=list">View All</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground">
            <Clock3 className="mx-auto mb-2 h-10 w-10 opacity-50" />
            <p className="text-sm">No pending actions</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <Link
                key={item.id}
                to={item.href}
                className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:border-primary/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.description}</p>
                </div>
                <div className="ml-3 flex items-center gap-2">
                  {item.description.includes('uploaded') ? (
                    <Upload className="h-4 w-4 text-info" />
                  ) : item.description.includes('review') ? (
                    <FileSearch className="h-4 w-4 text-warning" />
                  ) : (
                    <Clock3 className="h-4 w-4 text-muted-foreground" />
                  )}
                  {item.urgency === 'high' && <Badge variant="destructive">Now</Badge>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
