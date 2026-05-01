import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Inbox, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useNavigate } from 'react-router-dom';

interface ActivityRow {
  id: string;
  activity_type: string;
  created_at: string;
  lease_id: string;
  leases: {
    request_title: string | null;
    filename: string | null;
    lifecycle_status: string | null;
    workspace_id: string;
  };
}

interface ExtractionRow {
  id: string;
  request_title: string | null;
  filename: string | null;
  avg_confidence_score: number | null;
  model_locked: boolean | null;
  status: string | null;
  processed_at: string | null;
}

const LIFECYCLE_LABELS: Record<string, string> = {
  submitted: 'Submitted for approval',
  under_review: 'Under review',
  approved: 'Approved',
  executed: 'Executed',
  active: 'Active',
  expired: 'Expired',
  rejected: 'Rejected',
};

function getActivityLabel(activityType: string, lifecycleStatus?: string | null): string {
  switch (activityType) {
    case 'created': return 'Lease created';
    case 'status_change':
      return lifecycleStatus && LIFECYCLE_LABELS[lifecycleStatus]
        ? `Status \u2192 ${LIFECYCLE_LABELS[lifecycleStatus]}`
        : 'Status updated';
    case 'document_upload': return 'Document uploaded';
    case 'executed_uploaded': return 'Executed document uploaded';
    default: return activityType;
  }
}

function getDotColor(lifecycleStatus: string | null): string {
  switch (lifecycleStatus) {
    case 'submitted': return 'bg-blue-400';
    case 'under_review': return 'bg-amber-400';
    case 'approved': return 'bg-purple-400';
    case 'executed': return 'bg-indigo-400';
    case 'active': return 'bg-green-500';
    default: return 'bg-gray-400';
  }
}

function getRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayStart.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function RecentActivity() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [activityData, setActivityData] = useState<ActivityRow[]>([]);
  const [extractionData, setExtractionData] = useState<ExtractionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const [activityResult, extractionResult] = await Promise.all([
        supabase
          .from('lease_activity_log')
          .select('id, activity_type, created_at, lease_id, leases!inner(request_title, filename, lifecycle_status, workspace_id)')
          .eq('leases.workspace_id', workspace.id)
          .in('activity_type', ['created', 'status_change', 'document_upload', 'executed_uploaded'])
          .order('created_at', { ascending: false })
          .limit(4),
        (() => {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          return supabase
            .from('leases')
            .select('id, request_title, filename, avg_confidence_score, model_locked, status, processed_at')
            .eq('workspace_id', workspace.id)
            .or(`status.eq.Ready,and(status.eq.Processing,uploaded_at.gte.${cutoff})`)
            .order('processed_at', { ascending: false, nullsFirst: false })
            .limit(4);
        })(),
      ]);

      setActivityData((activityResult.data as unknown as ActivityRow[]) ?? []);
      setExtractionData((extractionResult.data as ExtractionRow[]) ?? []);
      setLoading(false);
    }
    fetchData();
  }, [workspace?.id]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4" />
            Recent Activity
          </div>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => navigate('/app/leases')}
          >
            All activity
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {activityData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No recent activity.</p>
            ) : (
              <div>
                {activityData.map((item) => {
                  const lease = item.leases;
                  const title = lease.request_title ?? lease.filename ?? 'Untitled';
                  const label = getActivityLabel(item.activity_type, lease.lifecycle_status);
                  const dotColor = getDotColor(lease.lifecycle_status);
                  const relDate = getRelativeDate(item.created_at);

                  return (
                    <div key={item.id} className="flex items-center gap-3 py-2 border-b last:border-0">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{title}</p>
                        <p className="text-xs text-muted-foreground">{label}</p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{relDate}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-4 mb-2">
              AI Extractions
            </p>

            {extractionData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-2">No extractions yet.</p>
            ) : (
              <div>
                {extractionData.map((item) => {
                  const title = item.request_title ?? item.filename ?? 'Untitled';
                  const score =
                    item.avg_confidence_score !== null
                      ? Math.round(item.avg_confidence_score * 100)
                      : null;
                  const isProcessing = item.status === 'Processing';

                  let badge: React.ReactNode;
                  if (isProcessing) {
                    badge = (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-secondary text-secondary-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Processing
                      </span>
                    );
                  } else if (item.model_locked) {
                    badge = (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">
                        Locked
                      </span>
                    );
                  } else if (item.avg_confidence_score !== null && item.avg_confidence_score < 0.8) {
                    badge = (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-700">
                        Needs Review
                      </span>
                    );
                  } else {
                    badge = (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700">
                        Reviewed
                      </span>
                    );
                  }

                  return (
                    <div key={item.id} className="flex items-center gap-3 py-1.5 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{title}</p>
                        {score !== null && !isProcessing && (
                          <p className="text-xs text-muted-foreground">{score}% confidence</p>
                        )}
                      </div>
                      {badge}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
