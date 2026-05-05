// DeleteWorkspaceDialog — Owner Workspace Management Checkpoint 3.
//
// Type-name-confirmation dialog for permanently deleting a workspace.
// Mirrors the GitHub / Stripe pattern: confirm button stays disabled
// until the typed string matches the workspace name exactly. Backed by
// the delete-workspace edge function, which performs the transactional
// cascade (leases → workspace → storage → audit row). See
// docs/OWNER_WORKSPACE_MGMT_BUILD_SPEC.md for the full contract.
//
// Server-side enforcement is duplicated in the edge function (auth as
// owner + confirmName match) — UI is defense out, not defense alone.

import { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface DeleteWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  /** Counts shown in the warning copy so the owner sees what they're erasing. */
  leaseCount: number;
  memberCount: number;
  /** Called once the edge function returns ok=true. Caller refetches AppContext. */
  onDeleted: () => void;
}

export function DeleteWorkspaceDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  leaseCount,
  memberCount,
  onDeleted,
}: DeleteWorkspaceDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset typed input when the dialog opens or the target workspace changes.
  useEffect(() => {
    if (open) setTyped('');
  }, [open, workspaceId]);

  const matches = typed === workspaceName;

  const handleDelete = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('delete-workspace', {
        body: { workspaceId, confirmName: typed },
      });
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || 'Failed to delete workspace';
        toast.error(msg);
        return;
      }
      const result = data as {
        ok: true;
        leaseCount: number;
        memberCount: number;
        storageObjectsPurged: number;
      };
      toast.success(
        `Workspace deleted — ${result.leaseCount} lease${result.leaseCount === 1 ? '' : 's'}, ${result.memberCount} member${result.memberCount === 1 ? '' : 's'}, ${result.storageObjectsPurged} file${result.storageObjectsPurged === 1 ? '' : 's'} removed`,
      );
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      console.error('delete-workspace error:', err);
      toast.error('Failed to delete workspace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Delete workspace
          </DialogTitle>
          <DialogDescription className="pt-2 text-foreground">
            This will permanently delete the <strong>{workspaceName}</strong>{' '}
            workspace and all of its data — every lease, every uploaded
            document, every approval policy, every audit log entry, every
            member assignment.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">This cannot be undone.</p>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground list-disc list-inside">
            <li>
              {leaseCount} lease{leaseCount === 1 ? '' : 's'} will be permanently deleted
            </li>
            <li>
              {memberCount} member{memberCount === 1 ? '' : 's'} will lose access immediately
            </li>
            <li>All uploaded PDF files will be purged from storage</li>
            <li>Approval policies, invites, and configuration will be erased</li>
          </ul>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-name" className="text-sm">
            Type <strong className="font-mono">{workspaceName}</strong> to confirm:
          </Label>
          <Input
            id="confirm-name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={workspaceName}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!matches || busy}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {busy ? 'Deleting…' : 'Delete workspace permanently'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
