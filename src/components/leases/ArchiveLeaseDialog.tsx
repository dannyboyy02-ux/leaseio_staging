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
import { Archive } from 'lucide-react';
import { useAppTranslation } from '@/hooks/useAppTranslation';

// #79: the Leases-list action is restorable ARCHIVE, not hard-delete — same
// semantics (and wording) as the detail page, so "archive" never gets confused
// with permanent deletion. Hard-delete is not offered from the list.
interface ArchiveLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseName: string;
  onConfirm: () => void;
}

export function ArchiveLeaseDialog({
  open,
  onOpenChange,
  leaseName,
  onConfirm,
}: ArchiveLeaseDialogProps) {
  const { t } = useAppTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Archive className="h-5 w-5 text-muted-foreground" />
            </div>
            <AlertDialogTitle>{t('archive.dialog_title')}</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="pt-2">
            {t('archive.dialog_desc', { name: leaseName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('archive.archive')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
