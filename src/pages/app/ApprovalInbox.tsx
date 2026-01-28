import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Clock, FileText, ChevronRight, Loader2, Building2, Cpu } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { WorkflowStatusBadge } from '@/components/workflow/WorkflowStatusBadge';
import { ApprovalDialog } from '@/components/workflow/ApprovalDialog';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';

interface PendingLease {
  id: string;
  filename: string;
  leaseType: string | null;
  lifecycleStatus: string;
  submittedAt: string | null;
  daysWaiting: number;
  initializerEmail: string | null;
}

export default function ApprovalInbox() {
  const { user } = useApp();
  const [pendingLeases, setPendingLeases] = useState<PendingLease[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLease, setSelectedLease] = useState<PendingLease | null>(null);
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);

  const fetchPendingApprovals = async () => {
    if (!user?.email) {
      setLoading(false);
      return;
    }

    try {
      // Get leases where the current user's email matches approver_email
      const { data: leases, error } = await supabase
        .from('leases')
        .select('*, profiles!leases_user_id_fkey(email)')
        .eq('approver_email', user.email)
        .eq('lifecycle_status', 'Pending Approval')
        .order('uploaded_at', { ascending: false });

      if (error) throw error;

      const now = new Date();
      const pending: PendingLease[] = (leases || []).map((lease: any) => {
        const submittedAt = lease.uploaded_at;
        const daysWaiting = Math.floor(
          (now.getTime() - new Date(submittedAt).getTime()) / (1000 * 60 * 60 * 24)
        );

        return {
          id: lease.id,
          filename: lease.filename || 'Untitled',
          leaseType: lease.lease_type,
          lifecycleStatus: lease.lifecycle_status,
          submittedAt,
          daysWaiting,
          initializerEmail: lease.profiles?.email || null,
        };
      });

      setPendingLeases(pending);
    } catch (error) {
      console.error('Error fetching pending approvals:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPendingApprovals();
  }, [user?.email]);

  const handleApprovalClick = (lease: PendingLease) => {
    setSelectedLease(lease);
    setApprovalDialogOpen(true);
  };

  const handleApprovalComplete = () => {
    fetchPendingApprovals();
  };

  const getLeaseTypeIcon = (type: string | null) => {
    if (type === 'Equipment') {
      return <Cpu className="h-4 w-4 text-muted-foreground" />;
    }
    return <Building2 className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <AppLayout>
      <AppHeader
        title="Approval Inbox"
        subtitle={`${pendingLeases.length} pending approval${pendingLeases.length !== 1 ? 's' : ''}`}
      />

      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : pendingLeases.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Clock className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium">No pending approvals</p>
            <p className="text-sm">Leases submitted for your approval will appear here</p>
          </div>
        ) : (
          <div className="space-y-3">
            {pendingLeases.map((lease) => (
              <Card 
                key={lease.id}
                className="hover:border-primary/50 transition-colors cursor-pointer"
                onClick={() => handleApprovalClick(lease)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {getLeaseTypeIcon(lease.leaseType)}
                        <h3 className="font-medium truncate">{lease.filename}</h3>
                        <WorkflowStatusBadge status={lease.lifecycleStatus} />
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        {lease.leaseType && (
                          <span>{lease.leaseType}</span>
                        )}
                        {lease.initializerEmail && (
                          <>
                            <span>•</span>
                            <span>From: {lease.initializerEmail}</span>
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
                      <Button variant="ghost" size="icon">
                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {selectedLease && (
        <ApprovalDialog
          leaseId={selectedLease.id}
          leaseFilename={selectedLease.filename}
          open={approvalDialogOpen}
          onOpenChange={setApprovalDialogOpen}
          onComplete={handleApprovalComplete}
        />
      )}
    </AppLayout>
  );
}
