import { useState } from 'react';
import { Lock, AlertTriangle, ShieldCheck } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface ModelLockConfirmationProps {
  leaseId: string;
  disabled?: boolean;
  onSuccess: () => void;
}

export function ModelLockConfirmation({ leaseId, disabled, onSuccess }: ModelLockConfirmationProps) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [locking, setLocking] = useState(false);

  const handleClose = (v: boolean) => { if (locking) return; setOpen(v); if (!v) setConfirmed(false); };

  const handleLock = async () => {
    if (!confirmed) return;
    setLocking(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const now = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('leases')
        .update({ model_locked: true, model_locked_at: now, model_locked_by: user.id, lifecycle_status: 'active' })
        .eq('id', leaseId);
      if (updateError) throw new Error(`Lock failed: ${updateError.message}`);
      await supabase.from('lease_activity_log').insert({
        lease_id: leaseId, user_id: user.id, activity_type: 'status_change',
        from_status: 'executed', to_status: 'active', details: { action: 'model_locked', locked_at: now },
      });
      toast.success('Model locked — lease is now Active');
      setOpen(false);
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || 'Failed to lock model');
    } finally {
      setLocking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm" disabled={disabled} className="gap-1.5 bg-success hover:bg-success/90 text-white">
          <Lock className="h-3.5 w-3.5" />Lock Model
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-success" />Lock Executed Record
          </DialogTitle>
          <DialogDescription>
            This action is irreversible. Once locked, executed terms and variance data cannot be modified.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2 text-warning">
              <AlertTriangle className="h-4 w-4" />What happens when you lock
            </p>
            <ul className="text-xs text-muted-foreground space-y-1 ml-6 list-disc">
              <li>All executed terms and variance fields are frozen</li>
              <li>Lease status moves to <strong>Active</strong></li>
              <li>Record appears in the Active Portfolio dashboard</li>
              <li>A lock event is written to the activity log</li>
            </ul>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox id="confirm-lock" checked={confirmed} onCheckedChange={(v) => setConfirmed(!!v)} />
            <Label htmlFor="confirm-lock" className="text-sm leading-snug cursor-pointer">
              I confirm the executed terms have been reviewed and are accurate. I understand this action cannot be undone.
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={locking}>Cancel</Button>
          <Button onClick={handleLock} disabled={!confirmed || locking} className="gap-1.5 bg-success hover:bg-success/90 text-white">
            {locking ? <><Lock className="h-4 w-4 animate-pulse" />Locking...</> : <><Lock className="h-4 w-4" />Lock & Activate</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
