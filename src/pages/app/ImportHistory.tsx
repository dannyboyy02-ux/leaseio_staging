import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { 
  Plus, 
  Search, 
  Loader2, 
  Eye, 
  RotateCcw, 
  Trash2, 
  FileText,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LeaseUploadModal } from '@/components/leases/LeaseUploadModal';
import { DeleteLeaseDialog } from '@/components/leases/DeleteLeaseDialog';
import { LeaseStatusBadge } from '@/components/leases/LeaseStatusBadge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
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
import { format } from 'date-fns';

interface ImportRow {
  id: string;
  filename: string;
  status: string;
  uploaded_at: string;
  processed_at: string | null;
  error_message: string | null;
  storage_path: string | null;
}

// Note: Using unified LeaseStatusBadge component for consistent status display

export default function ImportHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedLease, setSelectedLease] = useState<ImportRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const fetchImports = async () => {
    try {
      const { data, error } = await supabase
        .from('leases')
        .select('id, filename, status, uploaded_at, processed_at, error_message, storage_path')
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setImports(data || []);
    } catch (error) {
      console.error('Error fetching imports:', error);
      toast.error('Failed to load import history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchImports();

    const interval = setInterval(() => {
      const hasProcessing = imports.some(
        (i) => i.status === 'Processing' || i.status === 'Uploaded'
      );
      if (hasProcessing) {
        fetchImports();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [imports]);

  useEffect(() => {
    if (searchParams.get('action') === 'upload') {
      setUploadModalOpen(true);
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  const handleUploadSuccess = () => {
    fetchImports();
  };

  const handleRetry = async (importRow: ImportRow) => {
    if (!importRow.storage_path) {
      toast.error('Cannot retry: file not found in storage');
      return;
    }

    setRetryingId(importRow.id);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Please log in to retry');
        return;
      }

      const response = await supabase.functions.invoke('retry_lease', {
        body: { leaseId: importRow.id },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      toast.success('Re-processing started');
      fetchImports();
    } catch (error) {
      console.error('Retry error:', error);
      toast.error('Failed to retry processing');
    } finally {
      setRetryingId(null);
    }
  };

  const handleDeleteClick = (importRow: ImportRow) => {
    setSelectedLease(importRow);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedLease) return;

    try {
      if (selectedLease.storage_path) {
        const { error: storageError } = await supabase.storage
          .from('leases')
          .remove([selectedLease.storage_path]);
        
        if (storageError) {
          console.warn('Storage delete warning:', storageError);
        }
      }

      const { error: risksError } = await supabase
        .from('risks')
        .delete()
        .eq('lease_id', selectedLease.id);

      if (risksError) {
        console.warn('Risks delete warning:', risksError);
      }

      const { error: leaseError } = await supabase
        .from('leases')
        .delete()
        .eq('id', selectedLease.id);

      if (leaseError) throw leaseError;

      toast.success('Lease deleted successfully');
      setDeleteDialogOpen(false);
      setSelectedLease(null);
      fetchImports();
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete lease');
    }
  };

  const filteredImports = imports.filter((imp) =>
    !searchQuery || imp.filename.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <AppLayout>
      <AppHeader
        title={t('import.history')}
        subtitle={`${imports.length} ${t('import.documents_imported')}`}
        actions={
          <Button variant="accent" onClick={() => setUploadModalOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            {t('import.upload_lease')}
          </Button>
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-[40vh]">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : imports.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[40vh] text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">{t('import.no_imports')}</h3>
            <p className="text-muted-foreground mb-4">
              {t('import.upload_first')}
            </p>
            <Button variant="accent" onClick={() => setUploadModalOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {t('import.upload_lease')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Search */}
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t('import.search_filename')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            {/* Table */}
            <div className="rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('import.filename')}</TableHead>
                    <TableHead>{t('lease.status')}</TableHead>
                    <TableHead>{t('import.uploaded')}</TableHead>
                    <TableHead>{t('import.processed')}</TableHead>
                    <TableHead className="text-right">{t('import.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredImports.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                        No imports match your search
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredImports.map((imp) => (
                      <TableRow key={imp.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            <span className="truncate max-w-[200px]">{imp.filename}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <LeaseStatusBadge status={imp.status} />
                            {imp.status === 'Failed' && imp.error_message && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-xs text-destructive truncate max-w-[150px] cursor-help">
                                    {imp.error_message}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-sm">
                                  <p>{imp.error_message}</p>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {format(new Date(imp.uploaded_at), 'MMM d, yyyy h:mm a')}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {imp.status === 'Failed' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRetry(imp)}
                              disabled={retryingId === imp.id}
                              className="text-primary hover:text-primary"
                            >
                              {retryingId === imp.id ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-1" />
                              ) : (
                                <RotateCcw className="h-4 w-4 mr-1" />
                              )}
                              {t('import.retry')}
                            </Button>
                          ) : imp.processed_at ? (
                            format(new Date(imp.processed_at), 'MMM d, yyyy h:mm a')
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => navigate(`/app/leases/${imp.id}`)}
                                >
                                  <Eye className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('import.view')}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => handleDeleteClick(imp)}
                                  className="text-destructive hover:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{t('import.delete')}</TooltipContent>
                            </Tooltip>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      <LeaseUploadModal 
        open={uploadModalOpen} 
        onOpenChange={setUploadModalOpen}
        onSuccess={handleUploadSuccess}
      />

      <DeleteLeaseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        leaseName={selectedLease?.filename || ''}
        onConfirm={handleDeleteConfirm}
      />
    </AppLayout>
  );
}
