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
  FileText,
  Calendar,
  Building2,
  User,
  DollarSign,
  AlertTriangle
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DeleteLeaseDialog } from '@/components/leases/DeleteLeaseDialog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { format, differenceInDays, parseISO } from 'date-fns';

interface LeaseRow {
  id: string;
  filename: string;
  status: string;
  landlord_name: string | null;
  tenant_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  base_rent_amount: string | null;
  base_rent_frequency: string | null;
  uploaded_at: string;
  processed_at: string | null;
  extracted_json: Record<string, unknown> | null;
}

type SortField = 'property' | 'tenant' | 'landlord' | 'lease_start' | 'lease_end' | 'rent';
type SortDirection = 'asc' | 'desc';

const expirationFilters = [
  { value: 'all', label: 'All leases' },
  { value: '30', label: 'Expiring in 30 days' },
  { value: '60', label: 'Expiring in 60 days' },
  { value: '90', label: 'Expiring in 90 days' },
];

export default function Leases() {
  const navigate = useNavigate();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedLease, setSelectedLease] = useState<LeaseRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expirationFilter, setExpirationFilter] = useState('all');
  const [sortField, setSortField] = useState<SortField>('lease_end');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [leases, setLeases] = useState<LeaseRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLeases = async () => {
    try {
      const { data, error } = await supabase
        .from('leases')
        .select('*')
        .in('status', ['Ready', 'final', 'review'])
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setLeases((data || []) as LeaseRow[]);
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
      // Delete risks first
      await supabase.from('risks').delete().eq('lease_id', selectedLease.id);

      // Delete the lease
      const { error } = await supabase
        .from('leases')
        .delete()
        .eq('id', selectedLease.id);

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
    return sortDirection === 'asc' 
      ? <ArrowUp className="h-4 w-4" /> 
      : <ArrowDown className="h-4 w-4" />;
  };

  const getPropertyAddress = (lease: LeaseRow): string => {
    const json = lease.extracted_json as Record<string, unknown> | null;
    return (json?.property_address as string) || lease.filename;
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
    if (days < 0) {
      return <Badge variant="destructive">Expired</Badge>;
    }
    if (days <= 30) {
      return <Badge variant="destructive">{days} days</Badge>;
    }
    if (days <= 60) {
      return <Badge variant="warning">{days} days</Badge>;
    }
    if (days <= 90) {
      return <Badge variant="secondary">{days} days</Badge>;
    }
    return <span className="text-muted-foreground">{days} days</span>;
  };

  const parseRentAmount = (amount: string | null): number => {
    if (!amount) return 0;
    const cleaned = amount.replace(/[^0-9.]/g, '');
    return parseFloat(cleaned) || 0;
  };

  const filteredAndSortedLeases = useMemo(() => {
    let result = leases.filter((lease) => {
      // Search filter
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = !searchQuery || 
        getPropertyAddress(lease).toLowerCase().includes(searchLower) ||
        lease.tenant_name?.toLowerCase().includes(searchLower) ||
        lease.landlord_name?.toLowerCase().includes(searchLower);

      // Expiration filter
      let matchesExpiration = true;
      if (expirationFilter !== 'all') {
        const days = getDaysUntilExpiration(lease.lease_end);
        const filterDays = parseInt(expirationFilter);
        matchesExpiration = days !== null && days >= 0 && days <= filterDays;
      }

      return matchesSearch && matchesExpiration;
    });

    // Sort
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
        case 'rent':
          aVal = parseRentAmount(a.base_rent_amount);
          bVal = parseRentAmount(b.base_rent_amount);
          break;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [leases, searchQuery, expirationFilter, sortField, sortDirection]);

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    try {
      return format(parseISO(dateStr), 'MMM d, yyyy');
    } catch {
      return dateStr;
    }
  };

  const formatRent = (amount: string | null, frequency: string | null) => {
    if (!amount) return '—';
    const freq = frequency ? `/${frequency.replace('ly', '')}` : '';
    return `${amount}${freq}`;
  };

  return (
    <AppLayout>
      <AppHeader
        title="Lease Portfolio"
        subtitle={`${leases.length} active leases`}
        actions={
          <Button variant="accent" onClick={() => navigate('/app/imports?action=upload')}>
            <Plus className="h-4 w-4 mr-2" />
            Upload Lease
          </Button>
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-[40vh]">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : leases.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[40vh] text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">No leases yet</h3>
            <p className="text-muted-foreground mb-4">
              Upload and process your first lease to see it here
            </p>
            <Button variant="accent" onClick={() => navigate('/app/imports?action=upload')}>
              <Plus className="h-4 w-4 mr-2" />
              Upload Lease
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by property, tenant, or landlord..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={expirationFilter} onValueChange={setExpirationFilter}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {expirationFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>
                      {filter.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Table */}
            <div className="rounded-lg border border-border bg-card overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-3 h-8 data-[state=open]:bg-accent"
                        onClick={() => handleSort('property')}
                      >
                        <Building2 className="mr-2 h-4 w-4" />
                        Property
                        {getSortIcon('property')}
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-3 h-8"
                        onClick={() => handleSort('tenant')}
                      >
                        <User className="mr-2 h-4 w-4" />
                        Tenant
                        {getSortIcon('tenant')}
                      </Button>
                    </TableHead>
                    <TableHead className="hidden lg:table-cell">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-3 h-8"
                        onClick={() => handleSort('landlord')}
                      >
                        Landlord
                        {getSortIcon('landlord')}
                      </Button>
                    </TableHead>
                    <TableHead className="hidden md:table-cell">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-3 h-8"
                        onClick={() => handleSort('lease_start')}
                      >
                        <Calendar className="mr-2 h-4 w-4" />
                        Start
                        {getSortIcon('lease_start')}
                      </Button>
                    </TableHead>
                    <TableHead>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-3 h-8"
                        onClick={() => handleSort('lease_end')}
                      >
                        <Calendar className="mr-2 h-4 w-4" />
                        End
                        {getSortIcon('lease_end')}
                      </Button>
                    </TableHead>
                    <TableHead className="hidden sm:table-cell">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-3 h-8"
                        onClick={() => handleSort('rent')}
                      >
                        <DollarSign className="mr-2 h-4 w-4" />
                        Rent
                        {getSortIcon('rent')}
                      </Button>
                    </TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAndSortedLeases.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        No leases match your filters
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredAndSortedLeases.map((lease) => {
                      const daysUntil = getDaysUntilExpiration(lease.lease_end);
                      return (
                        <TableRow 
                          key={lease.id}
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => navigate(`/app/leases/${lease.id}`)}
                        >
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span className="truncate max-w-[200px]">
                                {getPropertyAddress(lease)}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="truncate max-w-[150px] block">
                              {lease.tenant_name || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell text-muted-foreground">
                            <span className="truncate max-w-[150px] block">
                              {lease.landlord_name || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-muted-foreground">
                            {formatDate(lease.lease_start)}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <span>{formatDate(lease.lease_end)}</span>
                              {getExpirationBadge(daysUntil)}
                            </div>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {formatRent(lease.base_rent_amount, lease.base_rent_frequency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
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
          </div>
        )}
      </div>

      <DeleteLeaseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        leaseName={selectedLease?.filename || ''}
        onConfirm={handleDeleteConfirm}
      />
    </AppLayout>
  );
}
