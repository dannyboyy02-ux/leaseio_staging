import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Search,
  Loader2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Eye,
  Trash2,
  Calendar,
  Building2,
  Ruler,
} from 'lucide-react';
import { format, differenceInDays, parseISO } from 'date-fns';
import { toast } from 'sonner';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DeleteLeaseDialog } from '@/components/leases/DeleteLeaseDialog';
import { EmptyLeaseState } from '@/components/leases/EmptyLeaseState';
import { LeaseStatusBadge } from '@/components/leases/LeaseStatusBadge';
import { LeaseRequestForm } from '@/components/workflow/LeaseRequestForm';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface LeaseRow {
  id: string;
  filename: string;
  status: string;
  lifecycle_status: string | null;
  request_title: string | null;
  landlord_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  executed_expiry_date: string | null;
  square_footage: number | null;
  executed_monthly_payment: number | null;
  current_monthly_rent: number | null;
  monthly_payment: number | null;
  extracted_json: Record<string, unknown> | null;
}

type SortField = 'property' | 'landlord' | 'monthly_rent' | 'lease_start' | 'lease_end' | 'sqft';
type SortDirection = 'asc' | 'desc';

// Statuses that represent in-flight (awaiting action) leases
const IN_FLIGHT_STATUSES = new Set(['submitted', 'under_review', 'approved']);

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function Leases() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [selectedLease, setSelectedLease] = useState<LeaseRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expirationFilter, setExpirationFilter] = useState('all');
  const [sortField, setSortField] = useState<SortField>('lease_end');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [leases, setLeases] = useState<LeaseRow[]>([]);
  const [loading, setLoading] = useState(true);

  const expirationFilters = [
    { value: 'all', label: 'All leases' },
    { value: '30', label: 'Expiring in 30 days' },
    { value: '90', label: 'Expiring in 90 days' },
  ];

  const fetchLeases = async () => {
    try {
      const { data, error } = await supabase
        .from('leases')
        .select(
          'id, filename, status, lifecycle_status, request_title, landlord_name, ' +
          'lease_start, lease_end, executed_expiry_date, square_footage, ' +
          'executed_monthly_payment, current_monthly_rent, monthly_payment, extracted_json'
        )
        .in('lifecycle_status', ['submitted', 'under_review', 'approved', 'executed', 'active', 'expired'])
        .order('lease_end', { ascending: true });

      if (error) throw error;
      setLeases((data || []) as unknown as LeaseRow[]);
    } catch (error) {
      console.error('Error fetching leases:', error);
      toast.error('Failed to load leases');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeases();
  }, []);

  const handleDeleteClick = (lease: LeaseRow) => {
    setSelectedLease(lease);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedLease) return;
    try {
      await supabase.from('risks').delete().eq('lease_id', selectedLease.id);
      const { error } = await supabase.from('leases').delete().eq('id', selectedLease.id);
      if (error) throw error;
      toast.success('Lease deleted successfully');
      setDeleteDialogOpen(false);
      setSelectedLease(null);
      fetchLeases();
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete lease');
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
    return lease.request_title || getExtractedFieldValue(json?.address) || lease.filename || '';
  };

  const getMonthlyRent = (lease: LeaseRow): number =>
    Number(lease.executed_monthly_payment) ||
    Number(lease.current_monthly_rent) ||
    Number(lease.monthly_payment) ||
    0;

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

  const formatSqFt = (sqft: number | null) => (sqft ? `${sqft.toLocaleString()} SF` : '\u2014');

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '\u2014';
    try {
      return format(parseISO(dateStr), 'MMM d, yyyy');
    } catch {
      return dateStr;
    }
  };

  const activeLeases = useMemo(
    () => leases.filter((l) => l.lifecycle_status === 'active' || l.lifecycle_status === 'executed'),
    [leases],
  );

  const totalMonthlyRent = useMemo(
    () => activeLeases.reduce((sum, l) => sum + getMonthlyRent(l), 0),
    [activeLeases],
  );

  const headerSubtitle = useMemo(() => {
    if (totalMonthlyRent > 0) {
      const count = activeLeases.length;
      return `${formatCurrency(totalMonthlyRent)} / mo \u00b7 ${count} ${count === 1 ? 'lease' : 'leases'}`;
    }
    return `${leases.length} ${leases.length === 1 ? 'lease' : 'leases'}`;
  }, [totalMonthlyRent, activeLeases, leases]);

  const filteredAndSortedLeases = useMemo(() => {
    const result = leases.filter((lease) => {
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch =
        !searchQuery ||
        getPropertyAddress(lease).toLowerCase().includes(searchLower) ||
        lease.landlord_name?.toLowerCase().includes(searchLower);

      let matchesExpiration = true;
      if (expirationFilter !== 'all') {
        const days = getDaysUntilExpiration(getLeaseEnd(lease));
        const filterDays = parseInt(expirationFilter, 10);
        matchesExpiration = days !== null && days >= 0 && days <= filterDays;
      }

      return matchesSearch && matchesExpiration;
    });

    result.sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      switch (sortField) {
        case 'property':
          aVal = getPropertyAddress(a).toLowerCase();
          bVal = getPropertyAddress(b).toLowerCase();
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
  }, [leases, searchQuery, expirationFilter, sortField, sortDirection]);

  return (
    <AppLayout>
      <AppHeader
        title={t('leases.title')}
        subtitle={headerSubtitle}
        actions={
          <Button variant="accent" onClick={() => setCreateDrawerOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Request
          </Button>
        }
      />

      <div className="space-y-4 p-6">
        {loading ? (
          <div className="flex h-[40vh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : leases.length === 0 ? (
          <EmptyLeaseState onNewRequest={() => setCreateDrawerOpen(true)} />
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-[320px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by property or landlord\u2026"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={expirationFilter} onValueChange={setExpirationFilter}>
                <SelectTrigger className="w-full sm:w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {expirationFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <Table>
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
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAndSortedLeases.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                        No leases match your filters
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredAndSortedLeases.map((lease) => {
                      const leaseEnd = getLeaseEnd(lease);
                      const daysUntil = getDaysUntilExpiration(leaseEnd);
                      const monthlyRent = getMonthlyRent(lease);
                      const isInFlight = IN_FLIGHT_STATUSES.has(lease.lifecycle_status || '');
                      return (
                        <TableRow
                          key={lease.id}
                          className={cn(
                            'cursor-pointer hover:bg-muted/50',
                            isInFlight && 'bg-muted/20'
                          )}
                          onClick={() => navigate(`/app/leases/${lease.id}`)}
                        >
                          <TableCell className="font-medium">
                            <span className="truncate max-w-[240px] block">{getPropertyAddress(lease)}</span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-muted-foreground">
                            {lease.landlord_name || '\u2014'}
                          </TableCell>
                          <TableCell className="tabular-nums font-medium">
                            {monthlyRent > 0 ? formatCurrency(monthlyRent) : '\u2014'}
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
                            <LeaseStatusBadge status={lease.lifecycle_status || lease.status} />
                          </TableCell>
                          <TableCell className="text-right">
                            <div
                              className="flex items-center justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => navigate(`/app/leases/${lease.id}`)}
                                  >
                                    <Eye className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>View details</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => handleDeleteClick(lease)}
                                    className="text-destructive hover:text-destructive"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Delete</TooltipContent>
                              </Tooltip>
                            </div>
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
      </div>

      <LeaseRequestForm
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={() => fetchLeases()}
      />

      <DeleteLeaseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        leaseName={selectedLease?.filename || ''}
      />
    </AppLayout>
  );
}
