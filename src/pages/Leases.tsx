import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Search, Filter, Grid3X3, List } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LeaseCard } from '@/components/leases/LeaseCard';
import { EmptyLeaseState } from '@/components/leases/EmptyLeaseState';
import { LeaseUploadModal } from '@/components/leases/LeaseUploadModal';
import { Lease, LeaseStatus } from '@/types';

// Mock data
const mockLeases: Lease[] = [
  {
    id: '1',
    workspaceId: '1',
    type: 'master',
    status: 'final',
    documentUrl: '/docs/lease1.pdf',
    documentName: 'Suite 100 Office Lease.pdf',
    lessor: 'Main Street Properties LLC',
    lessee: 'Acme Corporation',
    propertyAddress: '123 Main Street, Suite 100, New York, NY 10001',
    commencementDate: '2024-01-01',
    expirationDate: '2027-12-31',
    rentAmount: 5500,
    rentFrequency: 'monthly',
    createdBy: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finalizedAt: new Date().toISOString(),
    finalizedBy: '1',
  },
  {
    id: '2',
    workspaceId: '1',
    type: 'master',
    status: 'review',
    documentUrl: '/docs/lease2.pdf',
    documentName: 'Oak Avenue Retail Space.pdf',
    lessor: 'Oak Plaza Investments',
    lessee: 'Acme Corporation',
    propertyAddress: '456 Oak Avenue, Unit 2B, Brooklyn, NY 11201',
    commencementDate: '2024-03-01',
    expirationDate: '2026-02-28',
    rentAmount: 3200,
    rentFrequency: 'monthly',
    createdBy: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: '3',
    workspaceId: '1',
    type: 'amendment',
    parentLeaseId: '1',
    status: 'draft',
    documentUrl: '/docs/lease3.pdf',
    documentName: 'Suite 100 Amendment 1.pdf',
    lessor: 'Main Street Properties LLC',
    lessee: 'Acme Corporation',
    propertyAddress: '123 Main Street, Suite 100, New York, NY 10001',
    createdBy: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: '4',
    workspaceId: '1',
    type: 'master',
    status: 'processing',
    documentUrl: '/docs/lease4.pdf',
    documentName: 'Pine Boulevard Warehouse.pdf',
    createdBy: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const statusFilters: { value: LeaseStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All Leases' },
  { value: 'draft', label: 'Drafts' },
  { value: 'processing', label: 'Processing' },
  { value: 'review', label: 'Needs Review' },
  { value: 'final', label: 'Finalized' },
  { value: 'archived', label: 'Archived' },
];

export default function Leases() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<LeaseStatus | 'all'>('all');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // Open upload modal if action=upload in URL
  useEffect(() => {
    if (searchParams.get('action') === 'upload') {
      setUploadModalOpen(true);
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  const filteredLeases = mockLeases.filter((lease) => {
    const matchesSearch =
      !searchQuery ||
      lease.documentName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lease.propertyAddress?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lease.lessor?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lease.lessee?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || lease.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const isEmpty = mockLeases.length === 0;

  return (
    <AppLayout>
      <AppHeader
        title="Leases"
        subtitle={`${mockLeases.length} total documents`}
        actions={
          <Button variant="accent" onClick={() => setUploadModalOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Upload Lease
          </Button>
        }
      />

      <div className="p-6">
        {isEmpty ? (
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
                  onValueChange={(v) => setStatusFilter(v as LeaseStatus | 'all')}
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
                  <LeaseCard key={lease.id} lease={lease} index={index} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <LeaseUploadModal open={uploadModalOpen} onOpenChange={setUploadModalOpen} />
    </AppLayout>
  );
}
