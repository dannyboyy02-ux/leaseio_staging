import { ClipboardList, Upload } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface AddLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestApproval: () => void;
  onUploadDocument: () => void;
}

export function AddLeaseDialog({
  open,
  onOpenChange,
  onRequestApproval,
  onUploadDocument,
}: AddLeaseDialogProps) {
  function choose(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a Lease</DialogTitle>
          <DialogDescription>
            How would you like to add this lease?
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 pt-2">
          {/* Request Approval */}
          <button
            onClick={() => choose(onRequestApproval)}
            className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors">
              <ClipboardList className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-sm text-foreground">Request Approval</p>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                For leases not yet signed. Submit for manager and finance review before the commitment is made.
              </p>
            </div>
          </button>

          {/* Upload Document */}
          <button
            onClick={() => choose(onUploadDocument)}
            className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 group-hover:bg-primary/20 transition-colors">
              <Upload className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-sm text-foreground">Upload Document</p>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                For leases you already have signed. AI extracts the terms immediately — no approval needed.
              </p>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
