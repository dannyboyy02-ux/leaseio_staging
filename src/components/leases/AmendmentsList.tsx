import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileEdit, ExternalLink, Loader2, Archive } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatLocalizedDate } from '@/lib/dateFormatters';
import { useApp } from '@/contexts/AppContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';

import { localizedStatusLabel } from '@/lib/lifecycleLabels';
interface Amendment {
  id: string;
  filename: string;
  status: string;
  lifecycle_status: string | null;
  uploaded_at: string;
}

interface AmendmentsListProps {
  parentLeaseId: string;
  refreshTrigger?: number;
  /** Vault / read-only retention: hide the write affordance (archive) — the
   *  workspace is an archive and the server blocks the write anyway. */
  readOnly?: boolean;
}

export function AmendmentsList({ parentLeaseId, refreshTrigger, readOnly = false }: AmendmentsListProps) {
  const { userRole, refreshProfile } = useApp();
  const { user } = useAuth();
  const { t, language } = useAppTranslation();
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<Amendment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isAdmin = userRole === 'admin' || userRole === 'owner';

  const fetchAmendments = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('leases')
      .select('id, filename, status, lifecycle_status, uploaded_at')
      .eq('parent_lease_id', parentLeaseId)
      .eq('archived', false)
      .order('uploaded_at', { ascending: false });

    if (!error && data) {
      setAmendments(data);
    }
    setLoading(false);
  }, [parentLeaseId]);

  useEffect(() => {
    fetchAmendments();
  }, [fetchAmendments, refreshTrigger]);

  // "Delete" uses the same archive semantics as lease delete everywhere
  // else in the app: the child lease leaves the active set (and frees a
  // slot) without destroying data. Attribution lands on BOTH leases —
  // amendment_archived on the parent (where the action happened) and
  // lease_archived on the child (so its own history is complete) — and
  // both inserts are error-checked: an archive that can't be recorded is
  // surfaced, not silently swallowed.
  const handleConfirmedDelete = useCallback(async () => {
    if (!pendingDelete || !user?.id) return;
    setDeleting(true);
    try {
      const { error } = await (supabase as any)
        .from('leases')
        .update({
          archived: true,
          archived_at: new Date().toISOString(),
          archived_by: user.id,
        })
        .eq('id', pendingDelete.id);
      if (error) throw error;

      const { error: auditError } = await supabase.from('lease_activity_log').insert([
        {
          lease_id: parentLeaseId,
          user_id: user.id,
          activity_type: 'amendment_archived',
          details: { amendment_lease_id: pendingDelete.id, filename: pendingDelete.filename },
        },
        {
          lease_id: pendingDelete.id,
          user_id: user.id,
          activity_type: 'lease_archived',
          details: { parent_lease_id: parentLeaseId, filename: pendingDelete.filename },
        },
      ] as any);
      if (auditError) {
        console.error('Amendment archive audit insert failed:', auditError.message);
        toast.warning(t('amendments.delete_audit_warning'));
      } else {
        toast.success(t('amendments.delete_success'));
      }

      setPendingDelete(null);
      refreshProfile?.();
      await fetchAmendments();
    } catch (err: any) {
      toast.error(err?.message ?? t('amendments.delete_failed'));
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, user?.id, parentLeaseId, refreshProfile, fetchAmendments, t]);

  const getStatusBadge = (status: string, lifecycleStatus: string | null) => {
    const displayStatus = lifecycleStatus || status;
    switch (displayStatus) {
      case 'Processing':
      case 'Uploaded':
        return <Badge variant="secondary" className="text-xs">{t('lease.processing')}</Badge>;
      case 'Ready':
      case 'Review Required':
        return <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">{t('lease.needs_review')}</Badge>;
      case 'Posted':
        return <Badge variant="default" className="text-xs bg-green-600">{t('amendments.status_posted')}</Badge>;
      case 'Failed':
        return <Badge variant="destructive" className="text-xs">{t('lease.failed')}</Badge>;
      default:
        // Phase 3: route lifecycle_status values through displayLabel so
        // chain-vocabulary states (e.g. 'concept_submitted') render with
        // their canonical user-facing label instead of the raw enum.
        return <Badge variant="outline" className="text-xs">{localizedStatusLabel(displayStatus as LifecycleStatus)}</Badge>;
    }
  };

  if (loading) {
    return (
      <Card className="shadow-none border overflow-hidden">
        <CardHeader className="bg-muted/30 border-b py-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <FileEdit size={16} className="text-orange-600" />
            {t('amendments.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none border overflow-hidden">
      <CardHeader className="bg-muted/30 border-b py-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <FileEdit size={16} className="text-orange-600" />
          {t('amendments.title')}
          {amendments.length > 0 && (
            <Badge variant="outline" className="ml-1 text-xs">
              {amendments.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {amendments.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t('amendments.empty')}
          </p>
        ) : (
          <div className="space-y-3">
            {amendments.map((amendment) => (
              <div
                key={amendment.id}
                className="flex items-center justify-between p-3 rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{amendment.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('amendments.uploaded_on', { date: formatLocalizedDate(amendment.uploaded_at, language) })}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  {getStatusBadge(amendment.status, amendment.lifecycle_status)}
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/app/leases/${amendment.id}`} aria-label={t('amendments.open_aria', { name: amendment.filename })}>
                      <ExternalLink size={14} />
                    </Link>
                  </Button>
                  {isAdmin && !readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      aria-label={t('amendments.archive_aria', { name: amendment.filename })}
                      onClick={() => setPendingDelete(amendment)}
                    >
                      <Archive size={14} />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('amendments.delete_title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('amendments.delete_desc', { name: pendingDelete?.filename })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleConfirmedDelete();
                }}
                disabled={deleting}
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                {t('amendments.delete_confirm_cta')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
