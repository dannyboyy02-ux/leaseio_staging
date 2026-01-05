import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, Search, Filter, Grid3X3, List, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LeaseCard } from '@/components/leases/LeaseCard';
import { EmptyLeaseState } from '@/components/leases/EmptyLeaseState';
import { LeaseUploadModal } from '@/components/leases/LeaseUploadModal';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Database status values: 'Uploaded' | 'Processing' | 'Ready' | 'Failed'
type LeaseStatus = 'Uploaded' | 'Processing' | 'Ready' | 'Failed' | 'all';

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
  error_message: string | null;
}

const statusFilters: { value: LeaseStatus; label: string }[] = [
  { value: 'all', label: 'All Leases' },
  { value: 'Processing', label: 'Processing' },
  { value: 'Ready', label: 'Ready' },
  { value: 'Failed', label: 'Failed' },
];

export default function Leases() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<LeaseStatus>('all');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [leases, setLeases] = useState<LeaseRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch leases from Supabase
  const fetchLeases = async () => {
    try {
      const { data, error } = await supabase
        .from('leases')
        .select('*')
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setLeases(data || []);
    } catch (error) {
      console.error('Error fetching leases:', error);
      toast.error('Failed to load leases');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeases();

    // Poll for updates when any lease is in Processing or Uploaded status
    const interval = setInterval(() => {
      const hasProcessing = leases.some(
        (l) => l.status === 'Processing' || l.status === 'Uploaded'
      );
      if (hasProcessing) {
        fetchLeases();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [leases]);

  // Open upload modal if action=upload in URL
  useEffect(() => {
    if (searchParams.get('action') === 'upload') {
      setUploadModalOpen(true);
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  // Handle successful upload
  const handleUploadSuccess = (leaseId: string) => {
    fetchLeases(); // Refresh the list
  };

  const filteredLeases = leases.filter((lease) => {
    const matchesSearch =
      !searchQuery ||
      lease.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lease.landlord_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lease.tenant_name?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || lease.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const isEmpty = leases.length === 0;

  // Map DB status to LeaseCard status
  const mapStatus = (dbStatus: string): 'draft' | 'processing' | 'review' | 'final' | 'archived' => {
    switch (dbStatus) {
      case 'Uploaded':
      case 'Processing':
        return 'processing';
      case 'Ready':
        return 'final';
      case 'Failed':
        return 'review'; // Show as review so user can see the error
      default:
        return 'draft';
    }
  };

  // Transform DB row to Lease type for LeaseCard
  const transformToLease = (row: LeaseRow) => ({
    id: row.id,
    workspaceId: '1', // Will be from context in real app
    type: 'master' as const,
    status: mapStatus(row.status),
    documentUrl: '',
    documentName: row.filename,
    lessor: row.landlord_name || undefined,
    lessee: row.tenant_name || undefined,
    propertyAddress: undefined,
    commencementDate: row.lease_start || undefined,
    expirationDate: row.lease_end || undefined,
    rentAmount: row.base_rent_amount ? parseFloat(row.base_rent_amount.replace(/[^0-9.]/g, '')) : undefined,
    rentFrequency: row.base_rent_frequency as 'monthly' | 'quarterly' | 'annually' | undefined,
    createdBy: '1',
    createdAt: row.uploaded_at,
    updatedAt: row.uploaded_at,
  });

  return (
    <AppLayout>
      <AppHeader
        title="Leases"
        subtitle={`${leases.length} total documents`}
        actions={
          <Button variant="accent" onClick={() => setUploadModalOpen(true)}>
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
        ) : isEmpty ? (
          <EmptyLeaseState onUpload={() => setUploadModalOpen(true)} />
        ) : (
          <div className="space-y-6">
            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
              <div className="flex items-center gap-3 flex-1 w-full sm:w-auto">
                <div className="relative flex-1 max-w-md">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search leases..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <Button variant="outline" size="icon">
                  <Filter className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <Tabs
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as LeaseStatus)}
                >
                  <TabsList>
                    {statusFilters.slice(0, 4).map((filter) => (
                      <TabsTrigger key={filter.value} value={filter.value}>
                        {filter.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <div className="flex items-center border border-border rounded-lg p-1">
                  <Button
                    variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    onClick={() => setViewMode('list')}
                  >
                    <List className="h-4 w-4" />
                  </Button>
                  <Button
                    variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    onClick={() => setViewMode('grid')}
                  >
                    <Grid3X3 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Lease List */}
            {filteredLeases.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">No leases match your filters</p>
              </div>
            ) : (
              <div className={viewMode === 'grid' ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-3'}>
                {filteredLeases.map((lease, index) => (
                  <div 
                    key={lease.id} 
                    onClick={() => navigate(`/app/leases/${lease.id}`)}
                    className="cursor-pointer"
                  >
                    <LeaseCard lease={transformToLease(lease)} index={index} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <LeaseUploadModal 
        open={uploadModalOpen} 
        onOpenChange={setUploadModalOpen}
        onSuccess={handleUploadSuccess}
      />
    </AppLayout>
  );
}
