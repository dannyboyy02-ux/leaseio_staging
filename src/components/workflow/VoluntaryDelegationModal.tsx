// VoluntaryDelegationModal — Phase 7 Checkpoint 4.
//
// Triggered from a chain step row when the current user has a pending
// step assigned to them. Picks a workspace member as delegate, optional
// reason, calls voluntary-delegate-step.

import { useEffect, useState } from 'react';
import { Loader2, UserCheck } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { toast } from 'sonner';

interface VoluntaryDelegationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chainStepId: string | null;
  workspaceId: string;
  /** Called after successful delegation so the parent can refetch
   *  the approval queue / chain UI. */
  onDelegated: () => void;
}

interface MemberOption {
  id: string;
  display: string;
}

export function VoluntaryDelegationModal({
  open,
  onOpenChange,
  chainStepId,
  workspaceId,
  onDelegated,
}: VoluntaryDelegationModalProps) {
  const { user } = useApp();
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [delegateId, setDelegateId] = useState<string>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDelegateId('');
    setReason('');
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
      ).filter((id) => id !== user?.id); // exclude self
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
  }, [open, workspaceId, user?.id]);

  const handleSubmit = async () => {
    if (!chainStepId) return;
    if (!delegateId) {
      toast.error('Pick a delegate.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'voluntary-delegate-step',
        {
          body: {
            chainStepId,
            delegateUserId: delegateId,
            reason: reason.trim() || undefined,
          },
        },
      );
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error ||
          error?.message ||
          'Delegation failed';
        toast.error(msg);
        return;
      }
      toast.success("Step delegated — it's moved to their queue and out of yours. Revoke it from “Delegated by me” if needed.");
      onOpenChange(false);
      onDelegated();
    } catch (err: any) {
      console.error('[VoluntaryDelegationModal] error:', err);
      toast.error(err?.message || 'Delegation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5" />
            Delegate this step
          </DialogTitle>
          <DialogDescription>
            Hand this approval to a workspace member. They'll receive a
            notification and the step moves to their queue (and off yours).
            You can revoke it before they act from “Delegated by me” in your
            queue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="vd-delegate">Delegate to</Label>
            <Select value={delegateId} onValueChange={setDelegateId} disabled={busy}>
              <SelectTrigger id="vd-delegate">
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
            {members.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other members in this workspace to delegate to.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="vd-reason">Reason (optional)</Label>
            <Textarea
              id="vd-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g., out of office next week — Sarah will handle"
              disabled={busy}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={busy || !delegateId}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Delegate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
