// EscalateToConceptDialog — Phase 4 Checkpoint 4.
//
// Submitter-initiated rollback from in_negotiation to concept_under_review.
// Required reason captures the audit trail. Calls
// escalate-to-concept-approver edge function.

import { useState, useEffect } from 'react';
import { ArrowLeftCircle, AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface EscalateToConceptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  /** Called once the edge function returns ok:true. Caller should refresh
   *  the lease record so the new lifecycle_status renders. */
  onEscalated: () => void;
}

export function EscalateToConceptDialog({
  open,
  onOpenChange,
  leaseId,
  onEscalated,
}: EscalateToConceptDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setReason('');
  }, [open, leaseId]);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'escalate-to-concept-approver',
        { body: { leaseId, reason: trimmed } },
      );
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || 'Failed to escalate';
        toast.error(msg);
        return;
      }
      const result = data as {
        ok: true;
        newLifecycleStatus: string;
        newChainStepCount: number;
      };
      toast.success(
        `Escalated to concept review — ${result.newChainStepCount} chain step${result.newChainStepCount === 1 ? '' : 's'} reactivated`,
      );
      onOpenChange(false);
      onEscalated();
    } catch (err) {
      console.error('escalate error:', err);
      toast.error('Failed to escalate');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftCircle className="h-5 w-5 text-warning" />
            Escalate back to concept review
          </DialogTitle>
          <DialogDescription className="pt-2">
            Material terms have shifted during negotiation enough to require concept
            approver re-validation. The lease will roll back to
            <strong> Under Review</strong> and a fresh round of pending concept-stage
            chain steps will be created. Prior approvals are preserved in the audit trail.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium text-warning">This visibly resets the workflow.</p>
            <p className="text-muted-foreground">
              Your reason text is stored on the audit log so concept approvers know
              what changed.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reason">Reason for re-escalation (required)</Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Counterparty pushed total commitment from $1.2M to $1.6M; rent escalation cap removed; additional 5-year extension option added."
            rows={4}
            disabled={busy}
            maxLength={1000}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            {trimmed.length} / 1000 characters
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {busy ? 'Escalating…' : 'Escalate to concept review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
