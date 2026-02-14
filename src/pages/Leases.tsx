import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  User,
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
import { PipelineView } from '@/components/leases/PipelineView';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface LeaseRow {
  id: string;
  filename: string;
  status: string;
  lifecycle_status: string | null;
  request_title: string | null;
  requesting_department: string | null;
  request_urgency: string | null;
  category: string | null;
  vendor_name: string | null;
  landlord_name: string | null;
  tenant_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  square_footage: number | null;
  uploaded_at: string;
  status_changed_at: string | null;
  extracted_json: Record<string, unknown> | null;
  avg_confidence_score: number | null;
  estimated_monthly_cost_min: number | null;
  estimated_monthly_cost_max: number | null;
}

type SortField = 'property' | 'tenant' | 'landlord' | 'lease_start' | 'lease_end' | 'sqft';
type SortDirection = 'asc' | 'desc';
type LeaseViewMode = 'pipeline' | 'list';

const ConfidenceListBadge = ({ score }: { score: number | null }) => {
  if (score === null) {
    return <Badge variant="outline" className="text-[9px] text-muted-foreground">Pending</Badge>;
  }
  if (score >= 0.9) {
    return <Badge variant="outline" className="text-[9px] text-green-600 border-green-400 bg-green-50">High Confidence</Badge>;
  }
  if (score >= 0.7) {
    return <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-400 bg-amber-50">Review Needed</Badge>;
  }
  return <Badge variant="outline" className="text-[9px] text-red-600 border-red-400 bg-red-50">Verify Carefully</Badge>;
};

export default function Leases() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useLanguage();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [selectedLease, setSelectedLease] = useState<LeaseRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expirationFilter, setExpirationFilter] = useState('all');
  const [viewMode, setViewMode] = useState<LeaseViewMode>((searchParams.get('view') as LeaseViewMode) || 'pipeline');
  const [sortField, setSortField] = useState<SortField>('lease_end');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [leases, setLeases] = useState<LeaseRow[]>([]);
  const [loading, setLoading] = useState(true);


  const statusFilter = searchParams.get('status');

  const expirationFilters = [
    { value: 'all', label: t('leases.all_leases') },
    { value: '30', label: t('leases.expiring_30') },
    { value: '90', label: t('leases.expiring_90') },
  ];

  const fetchLeases = async () => {
    try {
      const { data, error } = await supabase
        .from('leases')
        .select('*')
        .in('lifecycle_status', ['requested', 'negotiating', 'pending_review', 'executed', 'active', 'expired', 'cancelled'])
        .order('uploaded_at', { ascending: false });

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
    return (lease.request_title || (json?.address as string) || lease.filename);
  };

  const getDaysUntilExpiration = (leaseEnd: string | null): number | null => {
    if (!leaseEnd) return null;
    try {
      return differenceInDays(parseISO(leaseEnd), new Date());
    } catch {
      return null;
    }
  };

  const getExpirationBadge = (days: number | null) => {
    if (days === null) return null;
    if (days < 0) return <Badge variant="destructive">{t('leases.expired')}</Badge>;
    if (days <= 30) return <Badge variant="destructive">{days} {t('dashboard.days')}</Badge>;
    if (days <= 60) return <Badge variant="warning">{days} {t('dashboard.days')}</Badge>;
    if (days <= 90) return <Badge variant="secondary">{days} {t('dashboard.days')}</Badge>;
    return <span className="text-muted-foreground">{days} {t('dashboard.days')}</span>;
  };

  const formatSqFt = (sqft: number | null) => (sqft ? `${sqft.toLocaleString()} SF` : '—');

  const filteredAndSortedLeases = useMemo(() => {
    const result = leases.filter((lease) => {
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = !searchQuery
        || getPropertyAddress(lease).toLowerCase().includes(searchLower)
        || lease.tenant_name?.toLowerCase().includes(searchLower)
        || lease.landlord_name?.toLowerCase().includes(searchLower)
        || lease.requesting_department?.toLowerCase().includes(searchLower)
        || lease.vendor_name?.toLowerCase().includes(searchLower);

      let matchesExpiration = true;
      if (expirationFilter !== 'all') {
        const days = getDaysUntilExpiration(lease.lease_end);
        const filterDays = parseInt(expirationFilter, 10);
        matchesExpiration = days !== null && days >= 0 && days <= filterDays;
      }

      const matchesStatus = !statusFilter || lease.lifecycle_status === statusFilter;

      return matchesSearch && matchesExpiration && matchesStatus;
    });

    result.sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      switch (sortField) {
        case 'property':
          aVal = getPropertyAddress(a).toLowerCase();
          bVal = getPropertyAddress(b).toLowerCase();
          break;
        case 'tenant':
          aVal = (a.tenant_name || '').toLowerCase();
          bVal = (b.tenant_name || '').toLowerCase();
          break;
        case 'landlord':
          aVal = (a.landlord_name || '').toLowerCase();
          bVal = (b.landlord_name || '').toLowerCase();
          break;
        case 'lease_start':
          aVal = a.lease_start || '';
          bVal = b.lease_start || '';
          break;
        case 'lease_end':
          aVal = a.lease_end || '';
          bVal = b.lease_end || '';
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
  }, [leases, searchQuery, expirationFilter, sortField, sortDirection, statusFilter]);

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    try {
      return format(parseISO(dateStr), 'MMM d, yyyy');
    } catch {
      return dateStr;
    }
  };

  return (
    <AppLayout>
      <AppHeader
        title={t('leases.title')}
        subtitle={`${leases.length} requests`}
        actions={
          <Button variant="accent" onClick={() => setCreateDrawerOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Lease Request
          </Button>
        }
      />

      <div className="space-y-4 p-6">
        {loading ? (
          <div className="flex h-[40vh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : leases.length === 0 ? (
          <EmptyLeaseState onUpload={() => setCreateDrawerOpen(true)} />
        ) : (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              {statusFilter && <Badge variant="outline">Filtered: {statusFilter.replace(/_/g, ' ')}</Badge>}
              <div className="inline-flex rounded-lg border bg-background p-1">
                <Button variant={viewMode === 'pipeline' ? 'default' : 'ghost'} size="sm" onClick={() => { setViewMode('pipeline'); setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set('view', 'pipeline'); return p; }); }}>
                  Pipeline View
                </Button>
                <Button variant={viewMode === 'list' ? 'default' : 'ghost'} size="sm" onClick={() => { setViewMode('list'); setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set('view', 'list'); return p; }); }}>
                  List View
                </Button>
              </div>

              {viewMode === 'list' && (
                <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
                  <div className="relative w-full sm:w-[320px]">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder={t('leases.search')}
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
              )}
            </div>

            {viewMode === 'pipeline' ? (
              <PipelineView leases={leases} onOpenLease={(leaseId) => navigate(`/app/leases/${leaseId}`)} />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('property')}>
                          <Building2 className="mr-2 h-4 w-4" />Request{getSortIcon('property')}
                        </Button>
                      </TableHead>
                      <TableHead>
                        <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('tenant')}>
                          <User className="mr-2 h-4 w-4" />Tenant{getSortIcon('tenant')}
                        </Button>
                      </TableHead>
                      <TableHead className="hidden lg:table-cell">
                        <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('landlord')}>
                          Landlord{getSortIcon('landlord')}
                        </Button>
                      </TableHead>
                      <TableHead className="hidden md:table-cell">Department</TableHead>
                      <TableHead className="hidden md:table-cell">
                        <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('lease_end')}>
                          <Calendar className="mr-2 h-4 w-4" />End{getSortIcon('lease_end')}
                        </Button>
                      </TableHead>
                      <TableHead className="hidden sm:table-cell">
                        <Button variant="ghost" size="sm" className="-ml-3 h-8" onClick={() => handleSort('sqft')}>
                          <Ruler className="mr-2 h-4 w-4" />{t('leases.sqft')}{getSortIcon('sqft')}
                        </Button>
                      </TableHead>
                      <TableHead className="hidden lg:table-cell">Confidence</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">{t('leases.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAndSortedLeases.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">{t('leases.no_match')}</TableCell>
                      </TableRow>
                    ) : (
                      filteredAndSortedLeases.map((lease) => {
                        const daysUntil = getDaysUntilExpiration(lease.lease_end);
                        return (
                          <TableRow key={lease.id} className="cursor-pointer hover:bg-muted/50" onClick={() => navigate(`/app/leases/${lease.id}`)}>
                            <TableCell className="font-medium">
                              <div className="flex flex-col">
                                <span className="truncate max-w-[240px]">{getPropertyAddress(lease)}</span>
                                {lease.request_urgency === 'urgent' && <Badge variant="destructive" className="mt-1 w-fit text-[10px]">Urgent</Badge>}
                              </div>
                            </TableCell>
                            <TableCell>{lease.tenant_name || '—'}</TableCell>
                            <TableCell className="hidden lg:table-cell text-muted-foreground">{lease.landlord_name || '—'}</TableCell>
                            <TableCell className="hidden md:table-cell">{lease.requesting_department || '—'}</TableCell>
                            <TableCell className="hidden md:table-cell">
                              <div className="flex flex-col gap-1">
                                <span>{formatDate(lease.lease_end)}</span>
                                {getExpirationBadge(daysUntil)}
                              </div>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">{formatSqFt(lease.square_footage)}</TableCell>
                            <TableCell className="hidden lg:table-cell"><ConfidenceListBadge score={lease.avg_confidence_score} /></TableCell>
                            <TableCell><LeaseStatusBadge status={lease.lifecycle_status || lease.status} /></TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/app/leases/${lease.id}`)}>
                                      <Eye className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('leases.view_details')}</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button variant="ghost" size="icon-sm" onClick={() => handleDeleteClick(lease)} className="text-destructive hover:text-destructive">
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t('leases.delete')}</TooltipContent>
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
            )}
          </>
        )}
      </div>

      <LeaseRequestForm open={createDrawerOpen} onOpenChange={setCreateDrawerOpen} onSuccess={() => fetchLeases()} />

      <DeleteLeaseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        leaseName={selectedLease?.filename || ''}
      />
    </AppLayout>
  );
}
