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
import { Trash2 } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

// Leases redesign Phase 3 — admin "Delete permanently" from the Leases list.
// DISTINCT from:
//   - ArchiveLeaseDialog       — restorable-forever operational hide.
//   - DeleteLeaseDialog        — ImportHistory's IMMEDIATE hard-delete of a
//                                draft/unconfirmed import (no grace window).
// This one soft-deletes via the delete-lease edge function: the lease (and its
// history + documents) is removed from the workspace right away and kept
// recoverable for 14 days on request, then the retention cron purges it. The
// dialog spells out that impact so the admin understands it before confirming.
// Admin-only + always-available is enforced at the call site (the kebab) and
// server-side (delete-lease authorizes workspace admin/owner).
interface DeleteLeaseWithRetentionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseName: string;
  onConfirm: () => void;
  /** Disables the actions while the delete request is in flight. */
  pending?: boolean;
}

export function DeleteLeaseWithRetentionDialog({
  open,
  onOpenChange,
  leaseName,
  onConfirm,
  pending = false,
}: DeleteLeaseWithRetentionDialogProps) {
  const { t } = useLanguage();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </div>
            <AlertDialogTitle>{t('leases.delete_title')}</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="pt-2">
            {t('leases.delete_desc', { name: leaseName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t('leases.delete_confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
