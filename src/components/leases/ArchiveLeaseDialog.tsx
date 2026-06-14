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
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Archive className="h-5 w-5 text-muted-foreground" />
            </div>
            <AlertDialogTitle>Archive Lease</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="pt-2">
            Archive <span className="font-medium text-foreground">"{leaseName}"</span>? It will be
            moved out of the active list but kept in full — find it under
            <span className="font-medium text-foreground"> "Show archived"</span> and restore it any
            time from the lease's detail page. Nothing is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
