import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Clock, FileCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LifecycleStatusBadge } from '@/components/lifecycle/LifecycleStatusBadge';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import type { LifecycleStatus } from '@/types/lifecycle';

interface PendingApprovalItem {
  id: string;
  filename: string;
  lifecycleStatus: LifecycleStatus;
  daysWaiting: number;
}

export function PendingApprovalsSection() {
  const { workspace, user } = useApp();
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);

  const isBusinessPlan = workspace?.plan === 'business';

  useEffect(() => {
    async function fetchPendingApprovals() {
      if (!user || !workspace || !isBusinessPlan) {
        setLoading(false);
        return;
      }

      try {
        // Get leases where user is an assigned approver
        const { data: approverAssignments, error: assignmentError } = await supabase
          .from('lease_approvers')
          .select('lease_id')
          .eq('approver_id', user.id)
          .is('approved_at', null);

        if (assignmentError) throw assignmentError;

        if (!approverAssignments || approverAssignments.length === 0) {
          setLoading(false);
          return;
        }

        const leaseIds = approverAssignments.map(a => a.lease_id);
        
        const { data: leases, error: leasesError } = await supabase
          .from('leases')
          .select('id, filename, lifecycle_status, submitted_for_approval_at, uploaded_at')
          .in('id', leaseIds)
          .in('lifecycle_status', ['pending_internal_approval', 'pending_execution_approval'])
          .limit(5);

        if (leasesError) throw leasesError;

        const now = new Date();
        const items: PendingApprovalItem[] = (leases || []).map((lease: any) => {
          const submittedAt = lease.submitted_for_approval_at || lease.uploaded_at;
          const daysWaiting = Math.floor(
            (now.getTime() - new Date(submittedAt).getTime()) / (1000 * 60 * 60 * 24)
          );

          return {
            id: lease.id,
            filename: lease.filename || 'Untitled',
            lifecycleStatus: lease.lifecycle_status,
            daysWaiting,
          };
        });

        setPendingApprovals(items);
      } catch (error) {
        console.error('Error fetching pending approvals:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchPendingApprovals();
  }, [user, workspace, isBusinessPlan]);

  // Don't render if not on business plan
  if (!isBusinessPlan) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Clock className="h-5 w-5 text-warning" />
          Pending Approvals
        </CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/app/approvals">View All</Link>
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : pendingApprovals.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <FileCheck className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No pending approvals</p>
          </div>
        ) : (
          <div className="space-y-3">
            {pendingApprovals.map((item) => (
              <Link
                key={item.id}
                to={`/app/leases/${item.id}`}
                className="flex items-center justify-between p-3 rounded-lg border hover:border-primary/50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{item.filename}</p>
                    <LifecycleStatusBadge status={item.lifecycleStatus} size="sm" />
                  </div>
                </div>
                <Badge 
                  variant={item.daysWaiting > 5 ? 'destructive' : 'outline'}
                  className="shrink-0"
                >
                  {item.daysWaiting === 0 ? 'Today' : `${item.daysWaiting}d`}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
