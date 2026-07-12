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
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { toast } from 'sonner';

interface DeleteWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  /** Counts shown in the warning copy so the owner sees what they're erasing. */
  leaseCount: number;
  memberCount: number;
  /** True when this is the owner's ONLY workspace (no other owned or member
   *  workspace to fall back to). Deleting it leaves them with no active
   *  workspace, so we add an extra acknowledgement gate. */
  isOnlyWorkspace?: boolean;
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
  isOnlyWorkspace = false,
  onDeleted,
}: DeleteWorkspaceDialogProps) {
  const { t } = useAppTranslation();
  const [typed, setTyped] = useState('');
  const [ackedLast, setAckedLast] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset inputs when the dialog opens or the target workspace changes.
  useEffect(() => {
    if (open) {
      setTyped('');
      setAckedLast(false);
    }
  }, [open, workspaceId]);

  // Name must match AND, if this is the last workspace, the consequence must be
  // explicitly acknowledged.
  const matches = typed === workspaceName && (!isOnlyWorkspace || ackedLast);

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
      void result; // counts were shown in the confirm dialog; keep the toast short
      toast.success(t('workspace.delete_dialog.success'));
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      console.error('delete-workspace error:', err);
      toast.error(t('workspace.delete_dialog.fail'));
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
            {t('workspace.delete_dialog.title')}
          </DialogTitle>
          <DialogDescription className="pt-2 text-foreground">
            {t('workspace.delete_dialog.intro_prefix')} <strong>{workspaceName}</strong>{' '}
            {t('workspace.delete_dialog.intro_suffix')}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">{t('workspace.delete_dialog.cannot_undo')}</p>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground list-disc list-inside">
            <li>{t('workspace.delete_dialog.leases_bullet', { count: leaseCount })}</li>
            <li>{t('workspace.delete_dialog.members_bullet', { count: memberCount })}</li>
            <li>{t('workspace.delete_dialog.files_bullet')}</li>
            <li>{t('workspace.delete_dialog.config_bullet')}</li>
          </ul>
        </div>

        {isOnlyWorkspace && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/20">
            <p className="font-medium text-amber-800 dark:text-amber-300">
              {t('workspace.delete_dialog.only_title')}
            </p>
            <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-300/90">
              {t('workspace.delete_dialog.only_body')}
            </p>
            <label className="mt-2 flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200 cursor-pointer">
              <Checkbox
                checked={ackedLast}
                onCheckedChange={(v) => setAckedLast(v === true)}
                disabled={busy}
                className="mt-0.5"
              />
              <span>{t('workspace.delete_dialog.only_ack')}</span>
            </label>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="confirm-name" className="text-sm">
            {t('workspace.delete_dialog.type_prefix')} <strong className="font-mono">{workspaceName}</strong>{' '}
            {t('workspace.delete_dialog.type_suffix')}
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
            {t('workspace.delete_dialog.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!matches || busy}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {busy ? t('workspace.delete_dialog.deleting') : t('workspace.delete_dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
