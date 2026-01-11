import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Clock, FileText, ChevronRight, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LifecycleStatusBadge } from '@/components/lifecycle/LifecycleStatusBadge';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import type { LifecycleStatus, LeaseCategory } from '@/types/lifecycle';
import { CATEGORY_LABELS } from '@/types/lifecycle';

interface PendingLease {
  id: string;
  filename: string;
  category: LeaseCategory | null;
  businessUnit: string | null;
  lifecycleStatus: LifecycleStatus;
  submittedAt: string | null;
  daysWaiting: number;
  approvalType: 'internal' | 'execution';
}

export default function ApprovalInbox() {
  const { workspace, user } = useApp();
  const [internalApprovals, setInternalApprovals] = useState<PendingLease[]>([]);
  const [executionApprovals, setExecutionApprovals] = useState<PendingLease[]>([]);
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
          .select('lease_id, approval_type, approved_at')
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
          .select('*')
          .in('id', leaseIds)
          .in('lifecycle_status', ['pending_internal_approval', 'pending_execution_approval']);

        if (leasesError) throw leasesError;

        const now = new Date();
        const internal: PendingLease[] = [];
        const execution: PendingLease[] = [];

        (leases || []).forEach((lease: any) => {
          const assignment = approverAssignments.find(a => a.lease_id === lease.id);
          const submittedAt = lease.submitted_for_approval_at || lease.uploaded_at;
          const daysWaiting = Math.floor(
            (now.getTime() - new Date(submittedAt).getTime()) / (1000 * 60 * 60 * 24)
          );

          const pendingLease: PendingLease = {
            id: lease.id,
            filename: lease.filename || 'Untitled',
            category: lease.category,
            businessUnit: lease.business_unit,
            lifecycleStatus: lease.lifecycle_status,
            submittedAt: submittedAt,
            daysWaiting,
            approvalType: assignment?.approval_type || 'internal',
          };

          if (lease.lifecycle_status === 'pending_internal_approval') {
            internal.push(pendingLease);
          } else if (lease.lifecycle_status === 'pending_execution_approval') {
            execution.push(pendingLease);
          }
        });

        setInternalApprovals(internal);
        setExecutionApprovals(execution);
      } catch (error) {
        console.error('Error fetching pending approvals:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchPendingApprovals();
  }, [user, workspace, isBusinessPlan]);

  if (!isBusinessPlan) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-6">
          <FileText className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-2xl font-semibold mb-2">Business Plan Required</h2>
          <p className="text-muted-foreground text-center max-w-md">
            The approval inbox is available exclusively on the Business plan.
          </p>
        </div>
      </AppLayout>
    );
  }

  const renderLeaseList = (leases: PendingLease[], emptyMessage: string) => {
    if (leases.length === 0) {
      return (
        <div className="text-center py-12 text-muted-foreground">
          <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p>{emptyMessage}</p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {leases.map((lease) => (
          <Link
            key={lease.id}
            to={`/app/leases/${lease.id}`}
            className="block"
          >
            <Card className="hover:border-primary/50 transition-colors cursor-pointer">
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-medium truncate">{lease.filename}</h3>
                      <LifecycleStatusBadge status={lease.lifecycleStatus} size="sm" />
                    </div>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      {lease.category && (
                        <span>{CATEGORY_LABELS[lease.category]}</span>
                      )}
                      {lease.businessUnit && (
                        <>
                          <span>•</span>
                          <span>{lease.businessUnit}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <Badge 
                        variant={lease.daysWaiting > 5 ? 'destructive' : lease.daysWaiting > 2 ? 'outline' : 'secondary'}
                        className={cn(
                          lease.daysWaiting > 5 && 'bg-destructive/10 text-destructive border-0'
                        )}
                      >
                        {lease.daysWaiting === 0 
                          ? 'Today' 
                          : `${lease.daysWaiting} day${lease.daysWaiting !== 1 ? 's' : ''} waiting`
                        }
                      </Badge>
                      {lease.submittedAt && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Submitted {format(new Date(lease.submittedAt), 'MMM d')}
                        </p>
                      )}
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    );
  };

  const totalPending = internalApprovals.length + executionApprovals.length;

  return (
    <AppLayout>
      <AppHeader
        title="Approval Inbox"
        subtitle={`${totalPending} pending approval${totalPending !== 1 ? 's' : ''}`}
      />

      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs defaultValue="internal" className="space-y-6">
            <TabsList>
              <TabsTrigger value="internal" className="gap-2">
                Internal Approval
                {internalApprovals.length > 0 && (
                  <Badge variant="secondary" className="ml-1">
                    {internalApprovals.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="execution" className="gap-2">
                Execution Approval
                {executionApprovals.length > 0 && (
                  <Badge variant="secondary" className="ml-1">
                    {executionApprovals.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="internal">
              {renderLeaseList(
                internalApprovals,
                'No leases pending internal approval'
              )}
            </TabsContent>

            <TabsContent value="execution">
              {renderLeaseList(
                executionApprovals,
                'No leases pending execution approval'
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
