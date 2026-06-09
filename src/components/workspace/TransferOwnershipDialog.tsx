// TransferOwnershipDialog — Workspace Management Phase 3 (spec §4.2).
//
// Lets the workspace owner hand control to an accepted member. Backed by
// the transfer-workspace-ownership edge function (owner-only, service-role
// inside — the workspaces UPDATE policy blocks authenticated owner_id
// reassignment). The prior owner is mandatorily demoted to admin and
// stays a member.
//
// v1 LIMITATION surfaced here and acknowledged via checkbox: the Stripe
// subscription stays on the original owner's payment method. Control
// transfers; billing does not.
//
// Server-side enforcement is duplicated in the edge function (auth as
// owner + accepted-member target) — UI is defense out, not defense alone.

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2, UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface TransferOwnershipDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  /** Current owner (auth.users.id) — excluded from the target list. */
  ownerId: string;
  /** Called once the edge function returns ok=true. Caller refetches AppContext. */
  onTransferred: () => void;
}

interface EligibleMember {
  user_id: string;
  name: string;
  email: string;
}

export function TransferOwnershipDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  ownerId,
  onTransferred,
}: TransferOwnershipDialogProps) {
  const [targetUserId, setTargetUserId] = useState<string>('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset selection when the dialog opens or the target workspace changes.
  useEffect(() => {
    if (open) {
      setTargetUserId('');
      setAcknowledged(false);
    }
  }, [open, workspaceId]);

  // Accepted members only — mirrors the edge function's eligibility rule
  // (user_id present + accepted_at present), minus the current owner.
  const { data: eligible = [], isLoading } = useQuery({
    queryKey: ['transfer-eligible-members', workspaceId],
    enabled: open && !!workspaceId,
    queryFn: async (): Promise<EligibleMember[]> => {
      const { data, error } = await supabase
        .from('workspace_members')
        .select('user_id, accepted_at')
        .eq('workspace_id', workspaceId)
        .not('user_id', 'is', null)
        .not('accepted_at', 'is', null)
        .neq('user_id', ownerId);
      if (error) throw error;

      const userIds = (data ?? [])
        .map((m) => m.user_id)
        .filter((id): id is string => !!id);
      if (userIds.length === 0) return [];

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', userIds);
      if (profilesError) throw profilesError;

      return userIds.map((id) => {
        const profile = profiles?.find((p) => p.id === id);
        return {
          user_id: id,
          email: profile?.email || 'Unknown',
          name:
            profile?.first_name && profile?.last_name
              ? `${profile.first_name} ${profile.last_name}`
              : profile?.email || 'Unknown user',
        };
      });
    },
  });

  const selected = eligible.find((m) => m.user_id === targetUserId);
  const canTransfer = !!selected && acknowledged && !busy;

  const handleTransfer = async () => {
    if (!canTransfer || !selected) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'transfer-workspace-ownership',
        { body: { workspaceId, targetUserId: selected.user_id } },
      );
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || 'Failed to transfer ownership';
        toast.error(msg);
        return;
      }
      toast.success(
        `Ownership of "${workspaceName}" transferred to ${selected.name}. You are now an admin.`,
      );
      onOpenChange(false);
      onTransferred();
    } catch (err) {
      console.error('transfer-workspace-ownership error:', err);
      toast.error('Failed to transfer ownership');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
            Transfer ownership
          </DialogTitle>
          <DialogDescription className="pt-2 text-foreground">
            Hand control of <strong>{workspaceName}</strong> to another member.
            You'll stay in the workspace as an admin.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : eligible.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <UserPlus className="h-4 w-4" />
              No eligible members yet
            </p>
            <p className="mt-1.5 text-xs">
              Ownership can only be transferred to a member who has accepted
              their invite. Invite someone from Manage members, then come back
              once they've joined.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="transfer-target" className="text-sm">
                New owner
              </Label>
              <Select
                value={targetUserId}
                onValueChange={setTargetUserId}
                disabled={busy}
              >
                <SelectTrigger id="transfer-target">
                  <SelectValue placeholder="Select a member…" />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.name} ({m.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border border-amber-300 bg-amber-50/50 dark:bg-amber-950/10 dark:border-amber-800 p-3 text-sm">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                What happens when you transfer
              </p>
              <ul className="mt-2 space-y-0.5 text-xs text-amber-800 dark:text-amber-300 list-disc list-inside">
                <li>The new owner gets full control — rename, members, delete</li>
                <li>You become an admin and keep access to the workspace</li>
                <li>
                  The subscription stays on your payment method for now —
                  contact support to move billing
                </li>
              </ul>
            </div>

            <div className="flex items-start gap-2">
              <Checkbox
                id="transfer-ack"
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
                disabled={busy}
                className="mt-0.5"
              />
              <Label
                htmlFor="transfer-ack"
                className="text-xs font-normal leading-snug text-muted-foreground"
              >
                I understand the subscription stays on my payment method and I
                will no longer control this workspace.
              </Label>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {eligible.length > 0 && (
            <Button onClick={handleTransfer} disabled={!canTransfer}>
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {busy ? 'Transferring…' : 'Transfer ownership'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
