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
import { useAppTranslation } from '@/hooks/useAppTranslation';

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
  const { t } = useAppTranslation();
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
          (data as any)?.error || error?.message || t('documents.escalate.failed');
        toast.error(msg);
        return;
      }
      const result = data as {
        ok: true;
        newLifecycleStatus: string;
        newChainStepCount: number;
      };
      toast.success(
        t('documents.escalate.success', { count: result.newChainStepCount }),
      );
      onOpenChange(false);
      onEscalated();
    } catch (err) {
      console.error('escalate error:', err);
      toast.error(t('documents.escalate.failed'));
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
            {t('documents.escalate.title')}
          </DialogTitle>
          <DialogDescription className="pt-2">
            {t('documents.escalate.desc_before')}
            <strong> {t('documents.escalate.under_review')}</strong> {t('documents.escalate.desc_after')}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium text-warning">{t('documents.escalate.warning_title')}</p>
            <p className="text-muted-foreground">
              {t('documents.escalate.warning_desc')}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reason">{t('documents.escalate.reason_label')}</Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('documents.escalate.reason_placeholder')}
            rows={4}
            disabled={busy}
            maxLength={1000}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            {t('documents.escalate.char_count', { chars: trimmed.length })}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {busy ? t('documents.escalate.escalating') : t('documents.escalate.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
