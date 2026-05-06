// DocumentsPanel — Phase 4 Checkpoint 4 composite.
//
// Wraps the timeline + the upload modal + (for in_negotiation leases)
// the escalate and advance buttons into a single component for the
// lease detail page. Owns its own data fetch + refresh.
//
// Visibility rules:
//   - Timeline is always visible (any workspace member can read).
//   - Upload button is visible to admin/editor/owner only.
//   - Escalate + Advance buttons are visible only when
//     lifecycleStatus === 'in_negotiation' AND user is submitter or
//     workspace owner/admin.
//
// "Advance to Final Review" is disabled until at least one
// final_negotiated document exists for the lease — the same
// precondition the edge function enforces. Defense in depth: UI
// disables, edge function rejects.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload, ArrowLeftCircle, ArrowRightCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { DocumentsTimeline, type DocumentRow } from './DocumentsTimeline';
import { UploadDocumentDialog } from './UploadDocumentDialog';
import { EscalateToConceptDialog } from './EscalateToConceptDialog';

interface DocumentsPanelProps {
  leaseId: string;
  workspaceId: string;
  /** lease.lifecycle_status — drives both the upload-type filter and
   *  the visibility of the escalate / advance buttons. */
  lifecycleStatus: string;
  /** lease.requestor_id — drives the submitter-only gate for escalate /
   *  advance. Falls back to user_id semantics when null. */
  requestorId: string | null;
  /** lease.user_id — the legacy "uploader" column; treated as a fallback
   *  submitter identity. */
  userId?: string | null;
  /** Called when the lease's lifecycle changes (escalate / advance) so
   *  the parent page can refetch the lease record. */
  onLifecycleChanged: () => void;
}

export function DocumentsPanel({
  leaseId,
  workspaceId,
  lifecycleStatus,
  requestorId,
  userId,
  onLifecycleChanged,
}: DocumentsPanelProps) {
  const { user, userRole } = useApp();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [advanceBusy, setAdvanceBusy] = useState(false);

  // ── Fetch document rows + uploader names ───────────────────────────
  const {
    data: documents = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['lease-documents', leaseId],
    enabled: !!leaseId,
    queryFn: async (): Promise<DocumentRow[]> => {
      const { data: rows, error } = await supabase
        .from('lease_documents')
        .select(
          'id, document_type, iteration_number, version_number, storage_path, filename, mime_type, file_size_bytes, uploaded_by, uploaded_at, notes, is_current_latest',
        )
        .eq('lease_id', leaseId);
      if (error) throw error;

      const docs = (rows ?? []) as Omit<DocumentRow, 'uploader_name'>[];
      if (docs.length === 0) return [];

      // Hydrate uploader names. RLS lets us see profiles for users we
      // share a workspace with; for cross-workspace uploaders (rare:
      // service-role inserts) we silently fall back to 'Unknown'.
      const uploaderIds = Array.from(new Set(docs.map((d) => d.uploaded_by)));
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', uploaderIds);
      const profileMap = new Map<string, string>();
      for (const p of (profiles ?? []) as Array<{
        id: string;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }>) {
        const display =
          p.first_name && p.last_name
            ? `${p.first_name} ${p.last_name}`
            : p.email ?? 'Unknown';
        profileMap.set(p.id, display);
      }
      return docs.map((d) => ({
        ...d,
        uploader_name: profileMap.get(d.uploaded_by) ?? null,
      }));
    },
  });

  // ── Visibility gates ───────────────────────────────────────────────
  const isAdminOrOwner = userRole === 'admin' || userRole === 'owner';
  const canUpload = isAdminOrOwner || userRole === 'editor';
  const isSubmitter =
    !!user && (user.id === requestorId || user.id === (userId ?? null));
  const canTransition = isSubmitter || isAdminOrOwner;
  const isNegotiating = lifecycleStatus === 'in_negotiation';

  const hasFinalNegotiated = useMemo(
    () => documents.some((d) => d.document_type === 'final_negotiated'),
    [documents],
  );

  // ── Advance handler ────────────────────────────────────────────────
  const handleAdvance = async () => {
    if (advanceBusy) return;
    setAdvanceBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'advance-to-final-review',
        { body: { leaseId } },
      );
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || 'Failed to advance';
        toast.error(msg);
        return;
      }
      toast.success('Advanced to final review');
      onLifecycleChanged();
    } catch (err) {
      console.error('advance error:', err);
      toast.error('Failed to advance');
    } finally {
      setAdvanceBusy(false);
    }
  };

  // ── Refresh hook for upload + escalate ─────────────────────────────
  const handleAfterUpload = () => {
    refetch();
  };
  const handleAfterEscalate = () => {
    refetch();
    onLifecycleChanged();
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">Documents</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {canUpload && (
                <Button size="sm" onClick={() => setUploadOpen(true)}>
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Upload Document
                </Button>
              )}
              {isNegotiating && canTransition && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEscalateOpen(true)}
                  >
                    <ArrowLeftCircle className="h-3.5 w-3.5 mr-1.5" />
                    Escalate to Concept
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={handleAdvance}
                    disabled={!hasFinalNegotiated || advanceBusy}
                    title={
                      !hasFinalNegotiated
                        ? 'Upload a Final Negotiated document first'
                        : 'Advance to final review'
                    }
                  >
                    {advanceBusy ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <ArrowRightCircle className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Advance to Final Review
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <DocumentsTimeline documents={documents} loading={isLoading} />
        </CardContent>
      </Card>

      {canUpload && (
        <UploadDocumentDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          workspaceId={workspaceId}
          leaseId={leaseId}
          lifecycleStatus={lifecycleStatus}
          onUploaded={handleAfterUpload}
        />
      )}

      {isNegotiating && canTransition && (
        <EscalateToConceptDialog
          open={escalateOpen}
          onOpenChange={setEscalateOpen}
          leaseId={leaseId}
          onEscalated={handleAfterEscalate}
        />
      )}
    </>
  );
}
