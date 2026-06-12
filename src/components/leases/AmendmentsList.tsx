import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileEdit, ExternalLink, Loader2, Trash2 } from 'lucide-react';
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
import { format } from 'date-fns';
import { useApp } from '@/contexts/AppContext';
import { useAuth } from '@/contexts/AuthContext';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';

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
}

export function AmendmentsList({ parentLeaseId, refreshTrigger }: AmendmentsListProps) {
  const { userRole, refreshProfile } = useApp();
  const { user } = useAuth();
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
  // slot) without destroying data, and the action is attributable via
  // archived_by plus an amendment_archived row on the parent lease.
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

      await supabase.from('lease_activity_log').insert({
        lease_id: parentLeaseId,
        user_id: user.id,
        activity_type: 'amendment_archived',
        details: { amendment_lease_id: pendingDelete.id, filename: pendingDelete.filename },
      } as any);

      toast.success('Amendment deleted');
      setPendingDelete(null);
      refreshProfile?.();
      await fetchAmendments();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to delete amendment');
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, user?.id, parentLeaseId, refreshProfile, fetchAmendments]);

  const getStatusBadge = (status: string, lifecycleStatus: string | null) => {
    const displayStatus = lifecycleStatus || status;
    switch (displayStatus) {
      case 'Processing':
      case 'Uploaded':
        return <Badge variant="secondary" className="text-xs">Processing</Badge>;
      case 'Ready':
      case 'Review Required':
        return <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">Needs Review</Badge>;
      case 'Posted':
        return <Badge variant="default" className="text-xs bg-green-600">Posted</Badge>;
      case 'Failed':
        return <Badge variant="destructive" className="text-xs">Failed</Badge>;
      default:
        // Phase 3: route lifecycle_status values through displayLabel so
        // chain-vocabulary states (e.g. 'concept_submitted') render with
        // their canonical user-facing label instead of the raw enum.
        return <Badge variant="outline" className="text-xs">{displayLabel(displayStatus as LifecycleStatus)}</Badge>;
    }
  };

  if (loading) {
    return (
      <Card className="shadow-none border overflow-hidden">
        <CardHeader className="bg-muted/30 border-b py-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <FileEdit size={16} className="text-orange-600" />
            Amendments
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
          Amendments
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
            No amendments linked to this lease.
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
                    Uploaded {format(new Date(amendment.uploaded_at), 'MMM d, yyyy')}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  {getStatusBadge(amendment.status, amendment.lifecycle_status)}
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/app/leases/${amendment.id}`} aria-label={`Open ${amendment.filename}`}>
                      <ExternalLink size={14} />
                    </Link>
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${amendment.filename}`}
                      onClick={() => setPendingDelete(amendment)}
                    >
                      <Trash2 size={14} />
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
              <AlertDialogTitle>Delete this amendment?</AlertDialogTitle>
              <AlertDialogDescription>
                {`"${pendingDelete?.filename}" will be removed from this lease's amendments. The action is recorded in the audit trail; an admin can restore it from the archived leases view.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleConfirmedDelete();
                }}
                disabled={deleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
