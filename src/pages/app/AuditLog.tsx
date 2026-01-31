import { useState, useEffect } from "react";
import { format } from "date-fns";
import { 
  Calendar, 
  Filter, 
  Download, 
  ChevronLeft, 
  ChevronRight,
  ArrowRight,
  User,
  FileText
} from "lucide-react";
import { Link } from "react-router-dom";

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

interface StateTransition {
  id: string;
  lease_id: string;
  from_status: string | null;
  to_status: string;
  from_lifecycle: string | null;
  to_lifecycle: string | null;
  transitioned_by: string | null;
  transition_reason: string | null;
  metadata: any;
  created_at: string;
  leases?: {
    id: string;
    tenant_name: string | null;
    landlord_name: string | null;
    filename: string;
  } | null;
}

const PAGE_SIZE = 20;

export default function AuditLog() {
  const [transitions, setTransitions] = useState<StateTransition[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [leaseIdFilter, setLeaseIdFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  useEffect(() => {
    fetchTransitions();
  }, [page, leaseIdFilter, statusFilter]);

  const fetchTransitions = async () => {
    setLoading(true);
    
    let query = supabase
      .from('lease_state_transitions')
      .select(`
        *,
        leases!lease_state_transitions_lease_id_fkey (
          id,
          tenant_name,
          landlord_name,
          filename
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (leaseIdFilter) {
      query = query.eq('lease_id', leaseIdFilter);
    }

    if (statusFilter) {
      query = query.or(`to_status.eq.${statusFilter},to_lifecycle.eq.${statusFilter}`);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching transitions:', error);
    } else {
      setTransitions(data || []);
      setTotalCount(count || 0);
    }

    setLoading(false);
  };

  const exportToCSV = () => {
    const headers = ['Timestamp', 'Lease', 'From Status', 'To Status', 'From Lifecycle', 'To Lifecycle', 'Reason'];
    const rows = transitions.map(t => [
      format(new Date(t.created_at), 'yyyy-MM-dd HH:mm:ss'),
      t.leases?.tenant_name || t.leases?.filename || t.lease_id,
      t.from_status || '',
      t.to_status,
      t.from_lifecycle || '',
      t.to_lifecycle || '',
      t.transition_reason || ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
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
    if (normalized.includes('posted') || normalized.includes('ready')) return 'default';
    if (normalized.includes('failed') || normalized.includes('rejected')) return 'destructive';
    if (normalized.includes('processing') || normalized.includes('pending')) return 'secondary';
    if (normalized.includes('draft')) return 'outline';
    return 'secondary';
  };

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <AppLayout>
      <AppHeader
        title="Audit Log"
        subtitle="Track all lease state transitions and changes"
        actions={
          <Button onClick={exportToCSV} variant="outline">
            <Download size={16} className="mr-2" />
            Export CSV
          </Button>
        }
      />

      <div className="p-6 space-y-6">
        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Filter size={16} />
              Filters
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">Lease ID</label>
                <Input
                  placeholder="Filter by Lease ID..."
                  value={leaseIdFilter}
                  onChange={(e) => {
                    setLeaseIdFilter(e.target.value);
                    setPage(0);
                  }}
                />
              </div>
              <div className="w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">Status</label>
                <Select
                  value={statusFilter}
                  onValueChange={(value) => {
                    setStatusFilter(value === 'all' ? '' : value);
                    setPage(0);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="Draft">Draft</SelectItem>
                    <SelectItem value="Pending Approval">Pending Approval</SelectItem>
                    <SelectItem value="Review Required">Review Required</SelectItem>
                    <SelectItem value="Posted">Posted</SelectItem>
                    <SelectItem value="Rejected">Rejected</SelectItem>
                    <SelectItem value="Processing">Processing</SelectItem>
                    <SelectItem value="Ready">Ready</SelectItem>
                    <SelectItem value="Failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Transitions Table */}
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Lease</TableHead>
                  <TableHead>Transition</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : transitions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                      No state transitions found
                    </TableCell>
                  </TableRow>
                ) : (
                  transitions.map((transition) => (
                    <TableRow key={transition.id}>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-2">
                          <Calendar size={14} className="text-muted-foreground" />
                          {format(new Date(transition.created_at), 'MMM d, yyyy')}
                          <span className="text-muted-foreground">
                            {format(new Date(transition.created_at), 'h:mm a')}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link 
                          to={`/app/leases/${transition.lease_id}`}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <FileText size={14} className="text-muted-foreground" />
                          <span className="truncate max-w-[200px]">
                            {transition.leases?.tenant_name || transition.leases?.filename || 'Unknown'}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {/* Status transition */}
                          {(transition.from_status || transition.to_status) && (
                            <div className="flex items-center gap-1">
                              {transition.from_status && (
                                <Badge variant={getStatusBadgeColor(transition.from_status)}>
                                  {transition.from_status}
                                </Badge>
                              )}
                              <ArrowRight size={12} className="text-muted-foreground" />
                              <Badge variant={getStatusBadgeColor(transition.to_status)}>
                                {transition.to_status}
                              </Badge>
                            </div>
                          )}
                          {/* Lifecycle transition */}
                          {transition.from_lifecycle !== transition.to_lifecycle && transition.to_lifecycle && (
                            <div className="flex items-center gap-1 ml-2">
                              {transition.from_lifecycle && (
                                <>
                                  <span className="text-xs text-muted-foreground">{transition.from_lifecycle}</span>
                                  <ArrowRight size={10} className="text-muted-foreground" />
                                </>
                              )}
                              <span className="text-xs font-medium">{transition.to_lifecycle}</span>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {transition.transition_reason || '-'}
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
                Showing {page * PAGE_SIZE + 1} - {Math.min((page + 1) * PAGE_SIZE, totalCount)} of {totalCount}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft size={16} />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
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
