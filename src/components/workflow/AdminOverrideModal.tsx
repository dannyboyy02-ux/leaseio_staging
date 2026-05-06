// AdminOverrideModal — Phase 7 Checkpoint 4.
//
// Workspace admin / owner forces a chain step outcome with full audit
// trail. Strong visual cues (red border, warning icon, explicit caveat)
// signal the gravity of the action. ≥20-char reason gate matches the
// edge function + DB CHECK.

import { useEffect, useState } from 'react';
import { AlertOctagon, Loader2, ShieldAlert } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type OverrideAction = 'approve' | 'reject' | 'send_back' | 'reassign' | 'cancel_step';

interface AdminOverrideModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chainStepId: string | null;
  workspaceId: string;
  /** Refresh callback after a successful override. */
  onOverridden: () => void;
}

interface MemberOption {
  id: string;
  display: string;
}

const ACTION_LABELS: Record<OverrideAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  send_back: 'Send Back',
  reassign: 'Reassign',
  cancel_step: 'Cancel Step',
};

const ACTION_DESCRIPTIONS: Record<OverrideAction, string> = {
  approve: 'Force-approve this step on behalf of the assignee.',
  reject: 'Reject the lease via this step (terminal).',
  send_back: 'Return the lease to the prior stage with this step\'s status reset.',
  reassign: 'Hand the step to a different workspace member; the step stays pending.',
  cancel_step: 'Mark the step superseded; used when it was incorrectly required.',
};

export function AdminOverrideModal({
  open,
  onOpenChange,
  chainStepId,
  workspaceId,
  onOverridden,
}: AdminOverrideModalProps) {
  const [action, setAction] = useState<OverrideAction>('approve');
  const [reason, setReason] = useState('');
  const [reassignTo, setReassignTo] = useState<string>('');
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAction('approve');
    setReason('');
    setReassignTo('');
    let cancelled = false;
    (async () => {
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
      const allIds = Array.from(
        new Set([...(ownerId ? [ownerId] : []), ...memberIds]),
      );
      if (allIds.length === 0) {
        if (!cancelled) setMembers([]);
        return;
      }
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', allIds);
      const opts: MemberOption[] = ((profiles ?? []) as any[])
        .map((p) => {
          const fn = (p.first_name as string | null) ?? '';
          const ln = (p.last_name as string | null) ?? '';
          const display =
            fn || ln ? `${fn} ${ln}`.trim() : (p.email as string) ?? 'Unknown';
          return { id: p.id, display };
        })
        .sort((a, b) => a.display.localeCompare(b.display));
      if (!cancelled) setMembers(opts);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const reasonValid = reason.trim().length >= 20;
  const reassignValid = action !== 'reassign' || !!reassignTo;

  const handleSubmit = async () => {
    if (!chainStepId) return;
    if (!reasonValid) {
      toast.error('Reason must be at least 20 characters.');
      return;
    }
    if (!reassignValid) {
      toast.error('Pick a reassign target.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'admin-override-step',
        {
          body: {
            chainStepId,
            action,
            reason: reason.trim(),
            ...(action === 'reassign' ? { reassignToUserId: reassignTo } : {}),
          },
        },
      );
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || 'Override failed';
        toast.error(msg);
        return;
      }
      toast.success('Admin override executed.');
      onOpenChange(false);
      onOverridden();
    } catch (err: any) {
      console.error('[AdminOverrideModal] error:', err);
      toast.error(err?.message || 'Override failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="border-l-4 border-l-destructive">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" />
            Admin Override
          </DialogTitle>
          <DialogDescription>
            <span className="flex items-start gap-2 text-destructive/90">
              <AlertOctagon className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                This override will be visible in the audit trail and the
                workspace's Admin Override report. The reason is captured
                permanently.
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="override-action">Action</Label>
            <Select
              value={action}
              onValueChange={(v) => setAction(v as OverrideAction)}
              disabled={busy}
            >
              <SelectTrigger id="override-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACTION_LABELS) as OverrideAction[]).map((a) => (
                  <SelectItem key={a} value={a}>
                    {ACTION_LABELS[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {ACTION_DESCRIPTIONS[action]}
            </p>
          </div>

          {action === 'reassign' && (
            <div className="space-y-2">
              <Label htmlFor="override-reassign">Reassign target</Label>
              <Select value={reassignTo} onValueChange={setReassignTo} disabled={busy}>
                <SelectTrigger id="override-reassign">
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
          )}

          <div className="space-y-2">
            <Label htmlFor="override-reason">
              Reason (≥20 characters, required)
            </Label>
            <Textarea
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder="e.g., Approver on parental leave; lease deadline tomorrow."
              disabled={busy}
              className={cn(
                reasonValid
                  ? 'border-success/50'
                  : reason.length > 0
                  ? 'border-warning/50'
                  : '',
              )}
            />
            <p
              className={cn(
                'text-[11px]',
                reasonValid ? 'text-success' : 'text-muted-foreground',
              )}
            >
              {reason.trim().length} / 20+ characters
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={busy || !reasonValid || !reassignValid}
          >
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            <ShieldAlert className="h-4 w-4 mr-2" />
            Execute Override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
