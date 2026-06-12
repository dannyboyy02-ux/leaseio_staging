import { useState, useEffect } from "react";
import { format } from "date-fns";
import {
  Calendar,
  Filter,
  Download,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
  FileText,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/contexts/AppContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";

interface ActivityRow {
  id: string;
  lease_id: string;
  activity_type: string;
  from_status: string | null;
  to_status: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  leases?: {
    id: string;
    tenant_name: string | null;
    landlord_name: string | null;
    filename: string | null;
    request_title: string | null;
    workspace_id: string;
  } | null;
  profiles?: {
    email: string | null;
  } | null;
}

const PAGE_SIZE = 20;

const ACTIVITY_LABELS: Record<string, string> = {
  created: 'Created',
  status_change: 'Status changed',
  approval: 'Approved',
  rejection: 'Rejected',
  send_back: 'Sent back',
  pause: 'Paused',
  nudge_sent: 'Nudge sent',
  document_upload: 'Document uploaded',
  comment: 'Comment',
  manager_approved: 'Manager approved',
  manager_rejected: 'Manager rejected',
  financial_approved: 'Financial approved',
  financial_rejected: 'Financial rejected',
  financial_returned: 'Returned for revision',
  resubmitted: 'Resubmitted',
  executed_uploaded: 'Executed document uploaded',
  executed_terms_extracted: 'Executed terms extracted',
  executed_terms_edited: 'Executed term edited',
  classification_resolved: 'Classification resolved',
  model_locked: 'Model locked',
  change_submitted: 'Changes submitted',
  unlock_approved: 'Unlock approved',
  unlock_rejected: 'Unlock rejected',
  change_approved: 'Changes approved',
  change_rejected: 'Changes rejected',
  change_canceled: 'Changes discarded',
  document_deleted: 'Document deleted',
  amendment_archived: 'Amendment deleted',
  // #76 remediation (2026-06-12) — orphaned writer values restored to the
  // CHECK; label them so restored rows render readably.
  counter_signature_overdue: 'Counter-signature overdue',
  counter_signature_received: 'Counter-signature received',
  deactivated_approver_reassigned: 'Deactivated approver reassigned',
  delegate_activated: 'Delegate activated',
  document_iteration_uploaded: 'Document iteration uploaded',
  negotiation_escalated_to_concept: 'Escalated to concept approver',
  ooo_revoked: 'Out of office revoked',
  ooo_routed_step: 'Step routed to out-of-office delegate',
  policy_assignee_validation_failed: 'Approver validation failed',
  voluntary_delegation_created: 'Delegation created',
  final_review_returned_to_negotiation: 'Final review returned to negotiation',
};

export default function AuditLog() {
  const { t } = useAppTranslation();
  const { workspace } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialLeaseId = searchParams.get('leaseId') ?? '';

  const [entries, setEntries] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [leaseIdFilter, setLeaseIdFilter] = useState(initialLeaseId);
  const [activityFilter, setActivityFilter] = useState<string>("");

  useEffect(() => {
    if (!workspace?.id) return;
    fetchEntries();
    // Keep URL in sync with active lease filter for shareable links.
    const next = new URLSearchParams(searchParams);
    if (leaseIdFilter) next.set('leaseId', leaseIdFilter);
    else next.delete('leaseId');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, leaseIdFilter, activityFilter, workspace?.id]);

  const fetchEntries = async () => {
    if (!workspace?.id) return;
    setLoading(true);

    let query = supabase
      .from('lease_activity_log')
      .select(`
        id,
        lease_id,
        activity_type,
        from_status,
        to_status,
        details,
        created_at,
        leases!inner (
          id,
          tenant_name,
          landlord_name,
          filename,
          request_title,
          workspace_id
        ),
        profiles!lease_activity_log_user_id_fkey (
          email
        )
      `, { count: 'exact' })
      .eq('leases.workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (leaseIdFilter) {
      query = query.eq('lease_id', leaseIdFilter);
    }

    if (activityFilter) {
      query = query.eq('activity_type', activityFilter);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching activity log:', error);
    } else {
      setEntries((data as unknown as ActivityRow[]) || []);
      setTotalCount(count || 0);
    }

    setLoading(false);
  };

  const exportToCSV = () => {
    const headers = [
      t('audit.timestamp'),
      t('audit.lease'),
      'Activity',
      'From Status',
      'To Status',
      'Routing Path',
    ];
    const rows = entries.map((row) => [
      format(new Date(row.created_at), 'yyyy-MM-dd HH:mm:ss'),
      row.leases?.request_title || row.leases?.tenant_name || row.leases?.filename || row.lease_id,
      ACTIVITY_LABELS[row.activity_type] ?? row.activity_type,
      row.from_status || '',
      row.to_status || '',
      (row.details && (row.details as Record<string, unknown>).routing_path as string) || '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `audit-log-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    link.click();
  };

  const getStatusBadgeColor = (status: string | null) => {
    if (!status) return 'secondary';
    const normalized = status.toLowerCase();
    if (normalized.includes('active') || normalized.includes('executed') || normalized.includes('approved')) return 'default';
    if (normalized.includes('failed') || normalized.includes('rejected')) return 'destructive';
    if (normalized.includes('submitted') || normalized.includes('under_review')) return 'secondary';
    if (normalized.includes('draft')) return 'outline';
    return 'secondary';
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <AppLayout>
      <AppHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle')}
        actions={
          <Button onClick={exportToCSV} variant="outline" disabled={entries.length === 0}>
            <Download size={16} className="mr-2" />
            {t('audit.export_csv')}
          </Button>
        }
      />

      <div className="p-6 space-y-6">
        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Filter size={16} />
              {t('audit.filters')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">{t('audit.lease_id')}</label>
                <Input
                  placeholder={t('audit.filter_by_lease')}
                  value={leaseIdFilter}
                  onChange={(e) => {
                    setLeaseIdFilter(e.target.value);
                    setPage(0);
                  }}
                />
              </div>
              <div className="w-[240px]">
                <label className="text-xs text-muted-foreground mb-1 block">Activity type</label>
                <Select
                  value={activityFilter || 'all'}
                  onValueChange={(value) => {
                    setActivityFilter(value === 'all' ? '' : value);
                    setPage(0);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All activity types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All activity types</SelectItem>
                    {Object.entries(ACTIVITY_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Activity log table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('audit.timestamp')}</TableHead>
                  <TableHead>{t('audit.lease')}</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>Transition</TableHead>
                  <TableHead>Actor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      {t('audit.loading')}
                    </TableCell>
                  </TableRow>
                ) : entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      {t('audit.no_transitions')}
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-2">
                          <Calendar size={14} className="text-muted-foreground" />
                          {format(new Date(row.created_at), 'MMM d, yyyy')}
                          <span className="text-muted-foreground">
                            {format(new Date(row.created_at), 'h:mm a')}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/app/leases/${row.lease_id}/review`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <FileText size={14} className="text-muted-foreground" />
                          <span className="truncate max-w-[200px]">
                            {row.leases?.request_title || row.leases?.tenant_name || row.leases?.filename || 'Unknown'}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {ACTIVITY_LABELS[row.activity_type] ?? row.activity_type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {(row.from_status || row.to_status) ? (
                          <div className="flex items-center gap-1">
                            {row.from_status && (
                              <Badge variant={getStatusBadgeColor(row.from_status)}>
                                {row.from_status.replace(/_/g, ' ')}
                              </Badge>
                            )}
                            {row.from_status && row.to_status && (
                              <ArrowRight size={12} className="text-muted-foreground" />
                            )}
                            {row.to_status && (
                              <Badge variant={getStatusBadgeColor(row.to_status)}>
                                {row.to_status.replace(/_/g, ' ')}
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {row.profiles?.email || '—'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="text-sm text-muted-foreground">
                {t('audit.showing')} {page * PAGE_SIZE + 1} - {Math.min((page + 1) * PAGE_SIZE, totalCount)} {t('audit.of')} {totalCount}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft size={16} />
                  {t('audit.previous')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  {t('audit.next')}
                  <ChevronRight size={16} />
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </AppLayout>
  );
}
