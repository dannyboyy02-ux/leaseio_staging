// CounterSignaturePanel — Phase 5 Checkpoint 4.
//
// Renders on the lease detail page when the lease is in
// `pending_counter_signature`. Shows urgency, execution owner +
// reassign affordance, due date, upload-counter-signed-doc button,
// and the "Confirm Counter-Signature Received" button that calls
// record-counter-signature.
//
// Visibility:
//   - Urgency banner: everyone in the workspace.
//   - Reassign: submitter, current execution owner, workspace
//     owner/admin.
//   - Confirm receipt: execution owner OR workspace owner/admin (the
//     edge function enforces this; UI matches).

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCcw,
  Upload,
  UserCog,
} from 'lucide-react';
import { format } from 'date-fns';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { UploadDocumentDialog } from '@/components/leases/documents/UploadDocumentDialog';

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import {
  counterSignatureUrgency,
  counterSignatureUrgencyLabel,
  type CounterSignatureUrgency,
} from '@/lib/lifecycleStates';

interface CounterSignaturePanelProps {
  leaseId: string;
  workspaceId: string;
  lifecycleStatus: string;
  /** lease.requestor_id for submitter checks. */
  requestorId: string | null;
  /** Legacy uploader column, used as fallback for submitter identity. */
  userId: string | null;
  /** lease.execution_owner_id. */
  executionOwnerId: string | null;
  /** lease.counter_signature_due_date. */
  dueDate: string | null;
  /** lease.counter_signature_reminder_count. */
  reminderCount: number | null;
  /** Refresh the parent's lease record after any state change. */
  onChanged: () => void;
}

interface MemberOption {
  id: string;
  display: string;
}

const URGENCY_STYLE: Record<CounterSignatureUrgency, { border: string; text: string }> = {
  on_track: { border: 'border-l-success', text: 'text-success' },
  approaching: { border: 'border-l-warning', text: 'text-warning' },
  due_today: { border: 'border-l-warning', text: 'text-warning' },
  overdue: { border: 'border-l-destructive', text: 'text-destructive' },
  critically_overdue: { border: 'border-l-destructive', text: 'text-destructive' },
  no_due_date: { border: 'border-l-muted', text: 'text-muted-foreground' },
};

export function CounterSignaturePanel({
  leaseId,
  workspaceId,
  lifecycleStatus,
  requestorId,
  userId,
  executionOwnerId,
  dueDate,
  reminderCount,
  onChanged,
}: CounterSignaturePanelProps) {
  const { user, userRole } = useApp();

  const [ownerName, setOwnerName] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>('');
  const [reassignReason, setReassignReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [hasCounterSignedDoc, setHasCounterSignedDoc] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Don't render if the lease isn't in the right state — defensive.
  const visible = lifecycleStatus === 'pending_counter_signature';

  const isAdminOrOwner = userRole === 'admin' || userRole === 'owner';
  const isSubmitter =
    !!user && (user.id === requestorId || user.id === userId);
  const isExecutionOwner = !!user && user.id === executionOwnerId;
  const canReassign = isSubmitter || isExecutionOwner || isAdminOrOwner;
  const canRecordReceipt = isExecutionOwner || isAdminOrOwner;

  // Resolve execution owner display name
  useEffect(() => {
    if (!executionOwnerId) {
      setOwnerName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .eq('id', executionOwnerId)
        .maybeSingle();
      if (cancelled) return;
      if (data) {
        const fn = (data.first_name as string | null) ?? '';
        const ln = (data.last_name as string | null) ?? '';
        const display = (fn || ln) ? `${fn} ${ln}`.trim() : (data.email as string) || 'Unknown';
        setOwnerName(display);
      } else {
        setOwnerName('Unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [executionOwnerId]);

  // Check whether a counter-signed doc has been uploaded already
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('lease_documents')
        .select('id')
        .eq('lease_id', leaseId)
        .eq('document_type', 'fully_executed_counterparty_returned')
        .limit(1);
      if (cancelled) return;
      setHasCounterSignedDoc(((data ?? []) as any[]).length > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId, visible, busy, uploadOpen]);

  const loadMembers = async () => {
    // Workspace owner + members. Skip the current execution owner (no-op
    // reassign) — the dropdown filters them out.
    const { data: ws } = await supabase
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    const ownerId = (ws as any)?.owner_id ?? null;

    const { data: memberRows } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId);
    const memberIds = ((memberRows ?? []) as any[]).map((m) => m.user_id);
    const allIds = Array.from(new Set([...(ownerId ? [ownerId] : []), ...memberIds]));

    const { data: profileRows } = await supabase
      .from('profiles')
      .select('id, email, first_name, last_name')
      .in('id', allIds);

    const opts: MemberOption[] = ((profileRows ?? []) as any[])
      .filter((p) => p.id !== executionOwnerId)
      .map((p) => {
        const fn = (p.first_name as string | null) ?? '';
        const ln = (p.last_name as string | null) ?? '';
        const display = (fn || ln) ? `${fn} ${ln}`.trim() : (p.email as string) || 'Unknown';
        return { id: p.id, display };
      })
      .sort((a, b) => a.display.localeCompare(b.display));
    setMembers(opts);
  };

  const handleOpenReassign = async () => {
    setReassignTo('');
    setReassignReason('');
    setReassignOpen(true);
    await loadMembers();
  };

  const handleReassign = async () => {
    if (!reassignTo) {
      toast.error('Pick a new execution owner.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('assign-execution-owner', {
        body: {
          leaseId,
          newOwnerId: reassignTo,
          reason: reassignReason.trim() || undefined,
        },
      });
      if (error || !(data as any)?.ok) {
        const msg = (data as any)?.error || error?.message || 'Reassignment failed';
        toast.error(msg);
        return;
      }
      toast.success('Execution owner reassigned.');
      setReassignOpen(false);
      onChanged();
    } catch (err: any) {
      console.error('[CounterSignaturePanel] reassign error:', err);
      toast.error(err?.message || 'Reassignment failed');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmReceipt = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('record-counter-signature', {
        body: { leaseId },
      });
      if (error || !(data as any)?.ok) {
        const msg = (data as any)?.error || error?.message || 'Failed to record';
        toast.error(msg);
        return;
      }
      toast.success('Counter-signature recorded. Lease moved to fully executed.');
      setConfirmOpen(false);
      onChanged();
    } catch (err: any) {
      console.error('[CounterSignaturePanel] confirm receipt error:', err);
      toast.error(err?.message || 'Failed to record');
    } finally {
      setBusy(false);
    }
  };

  const urgency = useMemo(() => counterSignatureUrgency(dueDate ?? null), [dueDate]);
  const style = URGENCY_STYLE[urgency];
  const dueDateFmt = useMemo(() => {
    if (!dueDate) return '—';
    try {
      return format(new Date(dueDate), 'MMM d, yyyy');
    } catch {
      return dueDate;
    }
  }, [dueDate]);

  if (!visible) return null;

  return (
    <>
      <Card className={cn('border-l-4', style.border)}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Counter-Signature
            </CardTitle>
            <Badge variant="outline" className={cn('text-xs', style.text)}>
              {counterSignatureUrgencyLabel(urgency)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Urgency message */}
          {urgency === 'critically_overdue' && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                This lease is 14+ days past its counter-signature due date. Escalate to
                leadership or consider cancellation if the counterparty has stalled.
              </span>
            </div>
          )}

          {/* Execution owner row */}
          <div className="flex items-center justify-between gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Execution owner</p>
              <p className="font-medium">{ownerName ?? '—'}</p>
            </div>
            {canReassign && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleOpenReassign}
                disabled={busy}
              >
                <UserCog className="h-3.5 w-3.5 mr-1.5" />
                Reassign
              </Button>
            )}
          </div>

          {/* Due date row */}
          <div className="flex items-center justify-between gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Due date</p>
              <p className="font-medium">{dueDateFmt}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Reminders sent</p>
              <p className="font-medium">{reminderCount ?? 0}</p>
            </div>
          </div>

          {/* Upload + confirm receipt */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setUploadOpen(true)}
              disabled={busy}
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Upload Counter-Signed Document
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={!canRecordReceipt || !hasCounterSignedDoc || busy}
              title={
                !canRecordReceipt
                  ? 'Only the execution owner or a workspace admin can record receipt.'
                  : !hasCounterSignedDoc
                  ? 'Upload a fully-executed counterparty-returned document first.'
                  : 'Mark counter-signature received and advance to fully executed.'
              }
            >
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              Confirm Counter-Signature Received
            </Button>
          </div>
        </CardContent>
      </Card>

      <UploadDocumentDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        workspaceId={workspaceId}
        leaseId={leaseId}
        lifecycleStatus={lifecycleStatus}
        onUploaded={() => {
          setHasCounterSignedDoc(true);
        }}
      />

      <Dialog open={reassignOpen} onOpenChange={(o) => !busy && setReassignOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Execution Owner</DialogTitle>
            <DialogDescription>
              The new owner becomes responsible for chasing the counter-signed document
              and receives reminders.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-owner">New execution owner</Label>
              <Select value={reassignTo} onValueChange={setReassignTo} disabled={busy}>
                <SelectTrigger id="new-owner">
                  <SelectValue placeholder="Select a workspace member" />
                </SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.display}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reassign-reason">Reason (optional)</Label>
              <Textarea
                id="reassign-reason"
                value={reassignReason}
                onChange={(e) => setReassignReason(e.target.value)}
                rows={3}
                maxLength={500}
                disabled={busy}
                placeholder="e.g., out of office for two weeks"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleReassign} disabled={busy || !reassignTo}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <RefreshCcw className="h-4 w-4 mr-2" />
              Reassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={(o) => !busy && setConfirmOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Counter-Signature Received</DialogTitle>
            <DialogDescription>
              This advances the lease to <strong>fully executed</strong>. The existing
              extraction flow takes over from there.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Make sure the most recent uploaded document is the counterparty's fully
            countersigned copy.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleConfirmReceipt} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
