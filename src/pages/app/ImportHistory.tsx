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
  Archive,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LeaseUploadModal } from '@/components/leases/LeaseUploadModal';
import { LimitReachedDialog } from '@/components/leases/LimitReachedDialog';
import { useWorkspaceQuota } from '@/hooks/useWorkspaceQuota';
import { DeleteLeaseDialog } from '@/components/leases/DeleteLeaseDialog';
import { LeaseStatusBadge } from '@/components/leases/LeaseStatusBadge';
import { isCommittedLease } from '@/lib/leaseDisposability';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
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
  lifecycle_status: string | null;
  model_locked: boolean | null;
}

// #116: a "committed" lease (model_locked, or any lifecycle_status beyond
// 'draft') carries an audit trail and is protected from client hard-delete by
// the prevent_committed_lease_hard_delete trigger. The UI steers it to the
// restorable Archive flow instead of offering a delete the DB would reject.
// Disposable imports (NULL/'draft' lifecycle, not locked) stay hard-deletable
// here for import rollback. isCommittedLease lives in @/lib/leaseDisposability
// (kept in lockstep with the SQL allowlist; behavior-tested there).

// Note: Using unified LeaseStatusBadge component for consistent status display

export default function ImportHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const { workspace } = useApp();
  const quota = useWorkspaceQuota();
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [limitWallOpen, setLimitWallOpen] = useState(false);

  // Limit wall gate — at the cap (no credit), upload opens the wall instead.
  // The server re-checks in process_lease, so this is UX, not enforcement.
  const openUpload = () => {
    if (quota.blocked) {
      setLimitWallOpen(true);
    } else {
      setUploadModalOpen(true);
    }
  };
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedLease, setSelectedLease] = useState<ImportRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const fetchImports = async () => {
    if (!workspace?.id) return;
    try {
      // Workspace scoping mandatory — see Leases.tsx for the same rationale.
      const { data, error } = await supabase
        .from('leases')
        .select('id, filename, status, uploaded_at, processed_at, error_message, storage_path, lifecycle_status, model_locked')
        .eq('workspace_id', workspace.id)
        .order('uploaded_at', { ascending: false });

      if (error) throw error;
      setImports(data || []);
    } catch (error) {
      console.error('Error fetching imports:', error);
      toast.error(t('import.load_failed'));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imports, workspace?.id]);

  useEffect(() => {
    if (searchParams.get('action') === 'upload') {
      openUpload();
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  const handleUploadSuccess = () => {
    fetchImports();
  };

  const handleRetry = async (importRow: ImportRow) => {
    if (!importRow.storage_path) {
      toast.error(t('import.retry_no_file'));
      return;
    }

    setRetryingId(importRow.id);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error(t('import.login_to_retry'));
        return;
      }

      const response = await supabase.functions.invoke('retry_lease', {
        body: { leaseId: importRow.id },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      toast.success(t('import.reprocessing_started'));
      fetchImports();
    } catch (error) {
      console.error('Retry error:', error);
      toast.error(t('import.retry_failed'));
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

      toast.success(t('import.delete_success'));
      setDeleteDialogOpen(false);
      setSelectedLease(null);
      fetchImports();
    } catch (error) {
      console.error('Delete error:', error);
      // The prevent_committed_lease_hard_delete trigger (#116) rejects deletes
      // of committed leases with an actionable message. Surface it verbatim if
      // present (the UI already steers committed leases to Archive, so this is a
      // defense-in-depth backstop) rather than a generic failure toast.
      const message =
        error instanceof Error && error.message ? error.message : t('import.delete_failed');
      toast.error(message);
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
          <Button variant="accent" onClick={() => openUpload()}>
            <Plus className="h-4 w-4 mr-2" />
            {t('import.upload_lease')}
          </Button>
        }
      />

      <PageLayout width="wide">
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
            <Button variant="accent" onClick={() => openUpload()}>
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
                        {t('import.no_match')}
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
                            {isCommittedLease(imp) ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => navigate(`/app/leases/${imp.id}?action=archive`)}
                                  >
                                    <Archive className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('import.archive_committed')}</TooltipContent>
                              </Tooltip>
                            ) : (
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
                            )}
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
      </PageLayout>

      <LeaseUploadModal
        open={uploadModalOpen}
        onOpenChange={setUploadModalOpen}
        onSuccess={handleUploadSuccess}
        onQuotaExceeded={() => {
          setUploadModalOpen(false);
          setLimitWallOpen(true);
        }}
      />

      <LimitReachedDialog open={limitWallOpen} onOpenChange={setLimitWallOpen} />

      <DeleteLeaseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        leaseName={selectedLease?.filename || ''}
        onConfirm={handleDeleteConfirm}
      />
    </AppLayout>
  );
}
