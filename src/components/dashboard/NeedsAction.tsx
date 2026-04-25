import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

interface PendingApproval {
  id: string;
  title: string;
  department: string;
  daysWaiting: number;
  annualValue: number;
}

interface OtherFlag {
  label: string;
  count: number;
}

export function NeedsAction() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [otherFlags, setOtherFlags] = useState<OtherFlag[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) {
        setLoading(false);
        return;
      }

      const { data: leases } = await supabase
        .from('leases')
        .select(
          'id, request_title, filename, requesting_department, monthly_payment, submitted_for_approval_at, status_changed_at, status, executed_document_url, lifecycle_status'
        )
        .eq('workspace_id', workspace.id)
        .in('lifecycle_status', ['under_review', 'executed', 'submitted']);

      if (!leases) {
        setLoading(false);
        return;
      }

      const now = Date.now();
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

      // Section A: Pending Approvals
      const approvals: PendingApproval[] = leases
        .filter((l) => l.lifecycle_status === 'under_review')
        .map((l) => {
          const referenceDate = l.submitted_for_approval_at ?? l.status_changed_at;
          const daysWaiting = referenceDate
            ? Math.floor((now - new Date(referenceDate).getTime()) / 86400000)
            : 0;
          return {
            id: l.id,
            title: l.request_title ?? l.filename ?? 'Unnamed lease',
            department: l.requesting_department ?? 'Unknown',
            daysWaiting,
            annualValue: (l.monthly_payment ?? 0) * 12,
          };
        })
        .sort((a, b) => b.daysWaiting - a.daysWaiting);

      // Section B: Other flags
      const flags: OtherFlag[] = [];

      // Stalled: under_review AND status_changed_at older than 14 days
      const stalledCount = leases.filter((l) => {
        if (l.lifecycle_status !== 'under_review') return false;
        if (!l.status_changed_at) return false;
        return now - new Date(l.status_changed_at).getTime() > fourteenDaysMs;
      }).length;
      if (stalledCount > 0) {
        flags.push({ label: 'Stalled in review', count: stalledCount });
      }

      // No abstraction: status IN ['Uploaded','Processing'] AND lifecycle_status IN ['submitted','under_review']
      const noAbstractionCount = leases.filter((l) => {
        const inLifecycle =
          l.lifecycle_status === 'submitted' || l.lifecycle_status === 'under_review';
        const inStatus = l.status === 'Uploaded' || l.status === 'Processing';
        return inLifecycle && inStatus;
      }).length;
      if (noAbstractionCount > 0) {
        flags.push({ label: 'Awaiting AI abstraction', count: noAbstractionCount });
      }

      // Executed, no doc
      const noDocCount = leases.filter(
        (l) => l.lifecycle_status === 'executed' && !l.executed_document_url
      ).length;
      if (noDocCount > 0) {
        flags.push({ label: 'Executed \u2014 document missing', count: noDocCount });
      }

      setPendingApprovals(approvals);
      setOtherFlags(flags);
      setLoading(false);
    }

    fetchData();
  }, [workspace?.id]);

  const totalCount = pendingApprovals.length + otherFlags.filter((f) => f.count > 0).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Needs Your Action
          </div>
          {!loading && totalCount > 0 && (
            <Badge variant="destructive">{totalCount}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse bg-muted h-12 rounded-lg" />
            ))}
          </div>
        ) : totalCount === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <CheckCircle2 className="h-8 w-8 text-green-500 mb-2" />
            <p className="text-sm text-muted-foreground">No actions required</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pendingApprovals.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Pending Approvals
                </p>
                {pendingApprovals.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                      item.daysWaiting > 5 ? 'bg-orange-50' : 'bg-muted/40'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">{item.department}</p>
                    </div>
                    <div className="ml-3 shrink-0 text-right">
                      <p
                        className={`text-xs font-medium ${
                          item.daysWaiting > 5 ? 'text-orange-600' : 'text-muted-foreground'
                        }`}
                      >
                        {item.daysWaiting}d waiting
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatCurrency(item.annualValue)}/yr
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {otherFlags.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Other Flags
                </p>
                {otherFlags.map((flag) => (
                  <div
                    key={flag.label}
                    className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm"
                  >
                    <span>{flag.label}</span>
                    <Badge variant="secondary">{flag.count}</Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="pt-1">
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => navigate('/app/leases')}
              >
                View all
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
