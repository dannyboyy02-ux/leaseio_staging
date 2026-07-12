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
import { AlertTriangle } from 'lucide-react';
import { useAppTranslation } from '@/hooks/useAppTranslation';

// Hard, permanent delete. As of #79 this is NOT used from the Leases list
// (which uses ArchiveLeaseDialog — restorable archive). It remains the
// deliberate hard-delete path for import rollback in ImportHistory, where
// removing a mis-imported lease entirely is the intended action.
interface DeleteLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseName: string;
  onConfirm: () => void;
}

export function DeleteLeaseDialog({
  open,
  onOpenChange,
  leaseName,
  onConfirm,
}: DeleteLeaseDialogProps) {
  const { t } = useAppTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <AlertDialogTitle>{t('leases.hard_delete.title')}</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="pt-2">
            {t('leases.hard_delete.desc', { name: leaseName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
