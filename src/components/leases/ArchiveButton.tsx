import { useState } from 'react';
import { Archive, ArchiveRestore, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface Props {
  leaseId: string;
  isArchived: boolean;
  /** Optional callback to refetch the lease after archive/unarchive succeeds. */
  onChange?: () => void;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost';
  /** Controlled mode — when both provided, the component renders only the
   * confirm dialog and the caller controls open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Admin-only archive / unarchive control. Hidden entirely for non-admins.
 *
 * Archiving moves a lease out of the active set without losing any data —
 * frees a slot against the workspace's maxActiveLeases cap and counts toward
 * the maxArchivedLeases cap. The locked-lease trigger has a carve-out for
 * archived/archived_at/archived_by, so this works for locked leases too.
 */
export function ArchiveButton({
  leaseId,
  isArchived,
  onChange,
  size = 'sm',
  variant = 'outline',
  open: controlledOpen,
  onOpenChange,
}: Props) {
  const { t } = useAppTranslation();
  const { userRole, refreshProfile } = useApp();
  const { user } = useAuth();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled ? onOpenChange : setInternalOpen;
  const [busy, setBusy] = useState(false);

  const isAdmin = userRole === 'admin' || userRole === 'owner';
  if (!isAdmin) return null;

  const apply = async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      const { error } = await (supabase as any)
        .from('leases')
        .update(
          isArchived
            ? { archived: false, archived_at: null, archived_by: null }
            : { archived: true, archived_at: new Date().toISOString(), archived_by: user.id }
        )
        .eq('id', leaseId);
      if (error) throw error;

      // Restore nulls archived_at/archived_by (the only column-level
      // attribution), so the activity log is the durable record of BOTH
      // directions — and the insert is error-checked, not fire-and-forget.
      const { error: auditError } = await supabase.from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: isArchived ? 'lease_restored' : 'lease_archived',
        details: {},
      } as any);
      if (auditError) {
        console.error('Archive audit insert failed:', auditError.message);
        toast.warning(t('archive.audit_warning'));
      } else {
        toast.success(isArchived ? t('archive.unarchived_toast') : t('archive.archived_toast'));
      }

      setOpen(false);
      // refresh both the lease record and the workspace counters
      onChange?.();
      refreshProfile?.();
    } catch (err: any) {
      console.error('Archive toggle error:', err);
      toast.error(err?.message ?? t('archive.failed'));
    } finally {
      setBusy(false);
    }
  };

  const Icon = isArchived ? ArchiveRestore : Archive;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <AlertDialogTrigger asChild>
          <Button variant={variant} size={size}>
            <Icon className="h-3.5 w-3.5 mr-1.5" />
            {isArchived ? t('archive.unarchive') : t('archive.archive')}
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isArchived ? t('archive.confirm_unarchive_title') : t('archive.confirm_archive_title')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isArchived ? t('archive.confirm_unarchive_desc') : t('archive.confirm_archive_desc')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={apply} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
            {isArchived ? t('archive.unarchive') : t('archive.archive')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
