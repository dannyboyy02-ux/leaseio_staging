import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Search,
  Loader2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Archive,
  ArchiveRestore,
  Calendar,
  Building2,
  Ruler,
  Tag,
  MoreHorizontal,
  Download,
} from 'lucide-react';
import { format, differenceInDays, parseISO } from 'date-fns';
import { toast } from 'sonner';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ArchiveLeaseDialog } from '@/components/leases/ArchiveLeaseDialog';
import { LeaseUploadModal } from '@/components/leases/LeaseUploadModal';
import { LimitReachedDialog } from '@/components/leases/LimitReachedDialog';
import { useWorkspaceQuota } from '@/hooks/useWorkspaceQuota';
import { AddLeaseDialog } from '@/components/leases/AddLeaseDialog';
import { EmptyLeaseState } from '@/components/leases/EmptyLeaseState';
import { LeaseStatusBadge } from '@/components/leases/LeaseStatusBadge';
import { LeaseRequestForm } from '@/components/workflow/LeaseRequestForm';
import { supabase } from '@/integrations/supabase/client';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { getMonthlyRent } from '@/lib/leaseCalculations';
import { rowsToCsv } from '@/lib/csv';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { isWorkspaceReadOnly } from '@/lib/workspaceReadOnly';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface LeaseRow {
  id: string;
  filename: string;
  status: string;
  lifecycle_status: string | null;
  request_title: string | null;
  landlord_name: string | null;
  asset_type: string | null;
  property_address: string | null;
  lease_start: string | null;
  lease_end: string | null;
  executed_expiry_date: string | null;
  square_footage: number | null;
  executed_monthly_payment: number | null;
  current_monthly_rent: number | null;
  monthly_payment: number | null;
  extracted_json: Record<string, unknown> | null;
  archived?: boolean | null;
  rent_schedules: {
    period_start: string;
    period_end: string | null;
    monthly_amount: number;
  }[] | null;
}

type SortField = 'property' | 'asset_type' | 'landlord' | 'monthly_rent' | 'lease_start' | 'lease_end' | 'sqft';
type SortDirection = 'asc' | 'desc';
// The Leases page is the lease PORTFOLIO (executed / active / expired). The
// archive scope — not the workflow lifecycle — is the page's primary axis.
// In-flight (approval) leases live on the Approvals page (see redirect below).
type StatusScope = 'all' | 'active' | 'archived';

// Lifecycle states that belong to the portfolio surface. In-flight/approval
// states are intentionally excluded — Approvals owns that lifecycle.
const PORTFOLIO_STATUSES = ['executed', 'active', 'fully_executed', 'expired', 'chain_violation'];

// snake_case asset_type → "Title Case" (matches ApprovalQueue / LeaseAudit).
const prettyAssetType = (t: string | null | undefined): string =>
  t ? t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';

export default function Leases() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
  const { workspace, user, userRole, refreshProfile } = useApp();
  // #136/#137: hide intake/archive affordances for ANY read-only workspace —
  // Vault OR a cancellation-grace/soft-deleted one (the server also blocks).
  const isReadOnly = isWorkspaceReadOnly(workspace);
  // Archive is admin/owner-only (server-enforced by the #78 trigger).
  const isAdmin = userRole === 'admin' || userRole === 'owner';
  const [searchParams] = useSearchParams();
  const quota = useWorkspaceQuota();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [addLeaseDialogOpen, setAddLeaseDialogOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [limitWallOpen, setLimitWallOpen] = useState(false);

  // Limit wall gate — at the cap (with no spendable credit), intake entry
  // points open the wall instead of the chooser. The server re-checks in
  // process_lease, so this is UX, not enforcement.
  const handleAddLease = () => {
    if (quota.blocked) {
      setLimitWallOpen(true);
    } else {
      setAddLeaseDialogOpen(true);
    }
  };
  const [selectedLease, setSelectedLease] = useState<LeaseRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expirationFilter, setExpirationFilter] = useState<'all' | '30' | '90' | '120'>(
    (['30', '90', '120'].includes(searchParams.get('expiring') ?? '') ? searchParams.get('expiring') : 'all') as 'all' | '30' | '90' | '120'
  );
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('lease_end');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  // Single scope control (replaces the Active/Approval tabs + the "Show
  // archived" toggle). Default ALL = active + archived together. Honors a
  // ?status= deep-link.
  const [scope, setScope] = useState<StatusScope>(
    (['active', 'archived', 'all'].includes(searchParams.get('status') ?? '')
      ? searchParams.get('status')
      : 'all') as StatusScope,
  );
  const [leases, setLeases] = useState<LeaseRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Approvals moved off this page — bounce any legacy ?view=approval deep-link
  // to the Approvals surface that now owns that lifecycle.
  useEffect(() => {
    if (searchParams.get('view') === 'approval') navigate('/app/approvals', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const expiryFilters = [
    { value: 'all', label: 'Expiry: all' },
    { value: '30', label: 'Expiring ≤ 30 days' },
    { value: '90', label: 'Expiring ≤ 90 days' },
    { value: '120', label: 'Expiring 91–120 days' },
  ];

  const fetchLeases = async () => {
    if (!workspace?.id) return;
    try {
      // Workspace scoping is mandatory: a user who is a member of multiple
      // workspaces would otherwise see every workspace's leases mixed together
      // (RLS allows them all; UI must scope to the active one).
      let query = (supabase as any)
        .from('leases')
        .select(
          'id, filename, status, lifecycle_status, request_title, landlord_name, asset_type, ' +
          'property_address, lease_start, lease_end, executed_expiry_date, square_footage, ' +
          'executed_monthly_payment, current_monthly_rent, monthly_payment, extracted_json, archived, ' +
          'rent_schedules(period_start, period_end, monthly_amount)'
        )
        .eq('workspace_id', workspace.id)
        .order('lease_end', { ascending: true });

      const portfolioList = PORTFOLIO_STATUSES.join(',');
      if (scope === 'active') {
        query = query.in('lifecycle_status', PORTFOLIO_STATUSES).eq('archived', false);
      } else if (scope === 'archived') {
        // Archived-only, including NULL-lifecycle rows (failed/processing uploads
        // and amendments never get one) so an archived failed item is still
        // reachable here to restore (#91).
        query = query
          .eq('archived', true)
          .or(`lifecycle_status.in.(${portfolioList}),lifecycle_status.is.null`);
      } else {
        // ALL: active portfolio (any archived flag) + archived failed/NULL rows.
        // Non-archived drafts/failures stay out of the portfolio list (they live
        // in ImportHistory / processing).
        query = query.or(
          `lifecycle_status.in.(${portfolioList}),and(archived.eq.true,lifecycle_status.is.null)`,
        );
      }

      const { data, error } = await query;

      if (error) throw error;
      setLeases((data || []) as unknown as LeaseRow[]);
    } catch (error) {
      console.error('Error fetching leases:', error);
      toast.error('Failed to load leases', { id: 'lease-list' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeases();
    // re-fetch when the scope filter changes OR the active workspace switches —
    // without the workspace dep, switching workspaces would leave the previous
    // workspace's leases on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, workspace?.id]);

  const handleArchiveClick = (lease: LeaseRow) => {
    setSelectedLease(lease);
    setDeleteDialogOpen(true);
  };

  // #79: the list action is restorable ARCHIVE, not hard-delete. Sets
  // archived=true; the #78 trigger stamps archived_by/archived_at server-side
  // (the client values here are overridden) and enforces admin/owner.
  // Toasts carry a stable id so rapid actions replace rather than stack.
  const handleArchiveConfirm = async () => {
    if (!selectedLease) return;
    try {
      const { error } = await supabase
        .from('leases')
        .update({ archived: true, archived_at: new Date().toISOString(), archived_by: user?.id ?? null })
        .eq('id', selectedLease.id);
      if (error) throw error;
      const { error: auditError } = await supabase.from('lease_activity_log').insert({
        lease_id: selectedLease.id,
        user_id: user?.id ?? null,
        activity_type: 'lease_archived',
        details: {},
      } as any);
      if (auditError) console.error('Archive audit insert failed:', auditError.message);
      toast.success(t('archive.list_archived_toast'), { id: 'lease-action' });
      setDeleteDialogOpen(false);
      setSelectedLease(null);
      await refreshProfile?.();
      fetchLeases();
    } catch (error) {
      console.error('Archive error:', error);
      toast.error(t('archive.list_archive_failed'), { id: 'lease-action' });
    }
  };

  // In-list restore (#91): mirrors ArchiveButton — non-destructive, admin-only
  // (the #78 trigger enforces server-side), logs lease_restored.
  const handleRestore = async (lease: LeaseRow) => {
    try {
      const { error } = await supabase
        .from('leases')
        .update({ archived: false, archived_at: null, archived_by: null })
        .eq('id', lease.id)
        .select('id');
      if (error) throw error;
      const { error: auditError } = await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user?.id ?? null,
        activity_type: 'lease_restored',
        details: {},
      } as any);
      if (auditError) console.error('Restore audit insert failed:', auditError.message);
      toast.success(t('archive.unarchived_toast'), { id: 'lease-action' });
      await refreshProfile?.();
      fetchLeases();
    } catch (error) {
      console.error('Restore error:', error);
      toast.error(t('archive.failed'), { id: 'lease-action' });
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="h-4 w-4" />;
    return sortDirection === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />;
  };

  const getPropertyAddress = (lease: LeaseRow): string => {
    const json = lease.extracted_json as Record<string, unknown> | null;
    return lease.request_title || lease.property_address || getExtractedFieldValue(json?.address) || lease.filename || '';
  };

  const getLeaseEnd = (lease: LeaseRow): string | null =>
    lease.executed_expiry_date || lease.lease_end;

  const getDaysUntilExpiration = (leaseEnd: string | null): number | null => {
    if (!leaseEnd) return null;
    try {
      return differenceInDays(parseISO(leaseEnd), new Date());
    } catch {
      return null;
    }
  };

  const getExpirationBadge = (days: number | null) => {
    if (days === null) return <span className="text-muted-foreground">&mdash;</span>;
    if (days < 0) return <Badge variant="destructive">Expired</Badge>;
    if (days <= 30) return <Badge variant="destructive">{days}d</Badge>;
    if (days <= 60) return <Badge className="bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-100">{days}d</Badge>;
    if (days <= 90) return <Badge variant="secondary">{days}d</Badge>;
    return <span className="text-sm text-muted-foreground">{days}d</span>;
  };

  const formatSqFt = (sqft: number | null) => (sqft ? `${sqft.toLocaleString()} SF` : '—');

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    try {
      return format(parseISO(dateStr), 'MMM d, yyyy');
    } catch {
      return dateStr;
    }
  };

  // Plain-text status for search + export (the visual badge is LeaseStatusBadge).
  const statusText = (lease: LeaseRow): string =>
    (lease.lifecycle_status || lease.status || '').replace(/_/g, ' ');

  // Active = live portfolio (not archived). Drives the header rent total.
  const activeLeases = useMemo(
    () => leases.filter((l) =>
      !l.archived &&
      (l.lifecycle_status === 'active' || l.lifecycle_status === 'executed' || l.lifecycle_status === 'fully_executed'),
    ),
    [leases],
  );

  const totalMonthlyRent = useMemo(
    () => activeLeases.reduce((sum, l) => sum + getMonthlyRent(l), 0),
    [activeLeases],
  );

  const headerSubtitle = useMemo(() => {
    const total = leases.length;
    const active = activeLeases.length;
    if (totalMonthlyRent > 0) {
      return `${formatCurrency(totalMonthlyRent)} / mo · ${active} active · ${total} total`;
    }
    return `${total} ${total === 1 ? 'lease' : 'leases'}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMonthlyRent, activeLeases, leases]);

  // Distinct asset types present in the loaded set — drives the Type filter
  // without a second fetch (workspace-configured shorthands arrive in Phase 2).
  const assetTypeOptions = useMemo(
    () => Array.from(new Set(leases.map((l) => l.asset_type).filter((x): x is string => !!x))).sort(),
    [leases],
  );

  const filteredAndSortedLeases = useMemo(() => {
    const searchLower = searchQuery.trim().toLowerCase();
    const result = leases.filter((lease) => {
      // Search across ANY visible attribute (property, type, landlord, status,
      // dates, sq ft, rent) — one lowercased haystack.
      const haystack = [
        getPropertyAddress(lease),
        prettyAssetType(lease.asset_type),
        lease.landlord_name,
        statusText(lease),
        formatDate(lease.lease_start),
        formatDate(getLeaseEnd(lease)),
        lease.square_footage ? `${lease.square_footage} sf` : '',
        getMonthlyRent(lease) ? formatCurrency(getMonthlyRent(lease)) : '',
      ].filter(Boolean).join(' ').toLowerCase();
      const matchesSearch = !searchLower || haystack.includes(searchLower);

      const matchesType = typeFilter === 'all' || lease.asset_type === typeFilter;

      let matchesExpiration = true;
      if (expirationFilter !== 'all') {
        const days = getDaysUntilExpiration(getLeaseEnd(lease));
        if (expirationFilter === '120') {
          matchesExpiration = days !== null && days > 90 && days <= 120;
        } else {
          const filterDays = parseInt(expirationFilter, 10);
          matchesExpiration = days !== null && days >= 0 && days <= filterDays;
        }
      }

      return matchesSearch && matchesType && matchesExpiration;
    });

    result.sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      switch (sortField) {
        case 'property':
          aVal = getPropertyAddress(a).toLowerCase();
          bVal = getPropertyAddress(b).toLowerCase();
          break;
        case 'asset_type':
          aVal = (a.asset_type || '').toLowerCase();
          bVal = (b.asset_type || '').toLowerCase();
          break;
        case 'landlord':
          aVal = (a.landlord_name || '').toLowerCase();
          bVal = (b.landlord_name || '').toLowerCase();
          break;
        case 'monthly_rent':
          aVal = getMonthlyRent(a);
          bVal = getMonthlyRent(b);
          break;
        case 'lease_start':
          aVal = a.lease_start || '';
          bVal = b.lease_start || '';
          break;
        case 'lease_end':
          aVal = getLeaseEnd(a) || '';
          bVal = getLeaseEnd(b) || '';
          break;
        case 'sqft':
          aVal = a.square_footage || 0;
          bVal = b.square_footage || 0;
          break;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leases, expirationFilter, typeFilter, searchQuery, sortField, sortDirection]);

  // Export the CURRENT filtered + sorted rows (WYSIWYG) as CSV.
  const handleExportCsv = () => {
    if (filteredAndSortedLeases.length === 0) {
      toast.error('Nothing to export', { id: 'lease-export' });
      return;
    }
    const records = filteredAndSortedLeases.map((l) => ({
      Property: getPropertyAddress(l),
      Type: prettyAssetType(l.asset_type),
      Landlord: l.landlord_name ?? '',
      'Monthly Rent': getMonthlyRent(l) || '',
      Start: l.lease_start ?? '',
      End: getLeaseEnd(l) ?? '',
      'Sq Ft': l.square_footage ?? '',
      Status: statusText(l),
      Archived: l.archived ? 'yes' : 'no',
    }));
    const csv = rowsToCsv(records);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leases-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${records.length} lease${records.length === 1 ? '' : 's'} to CSV`, { id: 'lease-export' });
  };

  return (
    <AppLayout>
      <AppHeader
        title={t('leases.title')}
        subtitle={headerSubtitle}
        actions={
          isReadOnly ? undefined : (
            <Button variant="accent" onClick={handleAddLease}>
              <Plus className="mr-2 h-4 w-4" />
              Add Lease
            </Button>
          )
        }
      />

      <PageLayout width="wide" spacing="space-y-4">
        {loading ? (
          <div className="flex h-[40vh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : leases.length === 0 ? (
          scope === 'archived' ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Archive className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No archived leases.</p>
              <Button variant="outline" onClick={() => setScope('all')}>
                Back to all leases
              </Button>
            </div>
          ) : (
            <EmptyLeaseState onAddLease={handleAddLease} readOnly={isReadOnly} />
          )
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="relative w-full sm:flex-1 sm:min-w-[220px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search property, landlord, type, status…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              {/* Status — the single scope control (Active / Archived / All). */}
              <Select value={scope} onValueChange={(v) => setScope(v as StatusScope)}>
                <SelectTrigger className="w-full sm:w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All leases</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              {/* Type filter — distinct asset types present in the list. */}
              {assetTypeOptions.length > 0 && (
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-full sm:w-[160px]">
                    <SelectValue placeholder="Type: all" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Type: all</SelectItem>
                    {assetTypeOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>{prettyAssetType(opt)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {/* Expiry — distinct from Status; keeps the Dashboard ?expiring= deep-link. */}
              <Select value={expirationFilter} onValueChange={(v) => setExpirationFilter(v as typeof expirationFilter)}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {expiryFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Export — overflow (CSV now; Excel arrives with the library decision). */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="Export leases" className="shrink-0">
                    <Download className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleExportCsv}>CSV (.csv)</DropdownMenuItem>
                  <DropdownMenuItem disabled className="opacity-60">Excel (.xlsx) — soon</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('property')}>
                        <Building2 className="mr-2 h-4 w-4" />
                        Property
                        {getSortIcon('property')}
                      </Button>
                    </TableHead>
                    <TableHead className="hidden md:table-cell">
                      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('asset_type')}>
                        <Tag className="mr-2 h-4 w-4" />
                        Type
                        {getSortIcon('asset_type')}
                      </Button>
                    </TableHead>
                    <TableHead className="hidden md:table-cell">
                      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('landlord')}>
                        Landlord
                        {getSortIcon('landlord')}
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('monthly_rent')}>
                        Monthly Rent
                        {getSortIcon('monthly_rent')}
                      </Button>
                    </TableHead>
                    <TableHead className="hidden sm:table-cell">
                      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('lease_start')}>
                        <Calendar className="mr-2 h-4 w-4" />
                        Start
                        {getSortIcon('lease_start')}
                      </Button>
                    </TableHead>
                    <TableHead className="hidden sm:table-cell">
                      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('lease_end')}>
                        <Calendar className="mr-2 h-4 w-4" />
                        End
                        {getSortIcon('lease_end')}
                      </Button>
                    </TableHead>
                    <TableHead>Days to Expiry</TableHead>
                    <TableHead className="hidden lg:table-cell">
                      <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('sqft')}>
                        <Ruler className="mr-2 h-4 w-4" />
                        Sq Ft
                        {getSortIcon('sqft')}
                      </Button>
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-[1%] text-right"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAndSortedLeases.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                        No leases match your filters
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredAndSortedLeases.map((lease) => {
                      const leaseEnd = getLeaseEnd(lease);
                      const daysUntil = getDaysUntilExpiration(leaseEnd);
                      const monthlyRent = getMonthlyRent(lease);
                      return (
                        <TableRow
                          key={lease.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => navigate(`/app/leases/${lease.id}`)}
                        >
                          <TableCell className="font-medium">
                            <span className="truncate max-w-[240px] block">{getPropertyAddress(lease)}</span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {lease.asset_type ? (
                              <Badge variant="outline" className="font-normal">{prettyAssetType(lease.asset_type)}</Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-muted-foreground">
                            {lease.landlord_name || '—'}
                          </TableCell>
                          <TableCell className="tabular-nums font-medium">
                            {monthlyRent > 0 ? formatCurrency(monthlyRent) : '—'}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell text-muted-foreground">
                            {formatDate(lease.lease_start)}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell text-muted-foreground">
                            {formatDate(leaseEnd)}
                          </TableCell>
                          <TableCell>{getExpirationBadge(daysUntil)}</TableCell>
                          <TableCell className="hidden lg:table-cell text-muted-foreground">
                            {formatSqFt(lease.square_footage)}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <LeaseStatusBadge status={lease.lifecycle_status || lease.status} />
                              {lease.archived && (
                                <Badge variant="outline" className="text-xs text-muted-foreground">
                                  {t('archive.deleted_badge')}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            {/* Archive/Restore is admin/owner-only (#78 trigger
                                enforces server-side); hidden on read-only Vault
                                workspaces. "Delete permanently" arrives in Phase 3
                                with its soft-delete + 14-day retention backend. */}
                            {!isReadOnly && isAdmin && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon-sm" aria-label="Lease actions">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {lease.archived ? (
                                    <DropdownMenuItem onClick={() => handleRestore(lease)}>
                                      <ArchiveRestore className="mr-2 h-4 w-4" />
                                      {t('archive.unarchive')}
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem onClick={() => handleArchiveClick(lease)}>
                                      <Archive className="mr-2 h-4 w-4" />
                                      {t('archive.archive')}
                                    </DropdownMenuItem>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </PageLayout>

      <AddLeaseDialog
        open={addLeaseDialogOpen}
        onOpenChange={setAddLeaseDialogOpen}
        onRequestApproval={() => setCreateDrawerOpen(true)}
        onUploadDocument={() => setUploadModalOpen(true)}
      />

      <LeaseRequestForm
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={() => fetchLeases()}
      />

      <ArchiveLeaseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleArchiveConfirm}
        leaseName={selectedLease?.filename || ''}
      />

      <LeaseUploadModal
        open={uploadModalOpen}
        onOpenChange={setUploadModalOpen}
        onSuccess={(leaseId) => { fetchLeases(); navigate(`/app/leases/${leaseId}`); }}
        onQuotaExceeded={() => {
          setUploadModalOpen(false);
          setLimitWallOpen(true);
        }}
      />

      <LimitReachedDialog open={limitWallOpen} onOpenChange={setLimitWallOpen} />
    </AppLayout>
  );
}
