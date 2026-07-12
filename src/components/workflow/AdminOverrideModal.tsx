// AdminOverrideModal — Phase 7 Checkpoint 4.
//
// Workspace admin / owner forces a chain step outcome with full audit
// trail. Strong visual cues (red border, warning icon, explicit caveat)
// signal the gravity of the action. ≥20-char reason gate matches the
// edge function + DB CHECK.

import { useEffect, useState } from 'react';
import { AlertOctagon, Loader2, ShieldAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';

type OverrideAction = 'approve' | 'reject' | 'send_back' | 'reassign' | 'cancel_step';

interface AdminOverrideModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chainStepId: string | null;
  workspaceId: string;
  /** Refresh callback after a successful override. */
  onOverridden: () => void;
}

interface MemberOption {
  id: string;
  display: string;
}

// Labels + descriptions come from the i18n catalog:
// workflow.override.actions.<action> / workflow.override.action_desc.<action>
const OVERRIDE_ACTIONS: OverrideAction[] = [
  'approve',
  'reject',
  'send_back',
  'reassign',
  'cancel_step',
];

export function AdminOverrideModal({
  open,
  onOpenChange,
  chainStepId,
  workspaceId,
  onOverridden,
}: AdminOverrideModalProps) {
  const { t } = useAppTranslation();
  const [action, setAction] = useState<OverrideAction>('approve');
  const [reason, setReason] = useState('');
  const [reassignTo, setReassignTo] = useState<string>('');
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAction('approve');
    setReason('');
    setReassignTo('');
    let cancelled = false;
    (async () => {
      const { data: ws } = await supabase
        .from('workspaces')
        .select('owner_id')
        .eq('id', workspaceId)
        .maybeSingle();
      const ownerId = (ws as any)?.owner_id ?? null;
      const { data: memberRows } = await supabase
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId);
      const memberIds = ((memberRows ?? []) as any[]).map((m) => m.user_id);
      const allIds = Array.from(
        new Set([...(ownerId ? [ownerId] : []), ...memberIds]),
      );
      if (allIds.length === 0) {
        if (!cancelled) setMembers([]);
        return;
      }
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', allIds);
      const opts: MemberOption[] = ((profiles ?? []) as any[])
        .map((p) => {
          const fn = (p.first_name as string | null) ?? '';
          const ln = (p.last_name as string | null) ?? '';
          const display =
            fn || ln ? `${fn} ${ln}`.trim() : (p.email as string) ?? t('workflow.common.unknown');
          return { id: p.id, display };
        })
        .sort((a, b) => a.display.localeCompare(b.display));
      if (!cancelled) setMembers(opts);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const reasonValid = reason.trim().length >= 20;
  const reassignValid = action !== 'reassign' || !!reassignTo;

  const handleSubmit = async () => {
    if (!chainStepId) return;
    if (!reasonValid) {
      toast.error(t('workflow.override.reason_min'));
      return;
    }
    if (!reassignValid) {
      toast.error(t('workflow.override.pick_target'));
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'admin-override-step',
        {
          body: {
            chainStepId,
            action,
            reason: reason.trim(),
            ...(action === 'reassign' ? { reassignToUserId: reassignTo } : {}),
          },
        },
      );
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || t('workflow.override.failed');
        toast.error(msg);
        return;
      }
      toast.success(t('workflow.override.executed'));
      onOpenChange(false);
      onOverridden();
    } catch (err: any) {
      console.error('[AdminOverrideModal] error:', err);
      toast.error(err?.message || t('workflow.override.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="border-l-4 border-l-destructive">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" />
            {t('workflow.override.title')}
          </DialogTitle>
          <DialogDescription>
            <span className="flex items-start gap-2 text-destructive/90">
              <AlertOctagon className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                {t('workflow.override.warning')}
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="override-action">{t('workflow.override.action')}</Label>
            <Select
              value={action}
              onValueChange={(v) => setAction(v as OverrideAction)}
              disabled={busy}
            >
              <SelectTrigger id="override-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OVERRIDE_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(`workflow.override.actions.${a}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(`workflow.override.action_desc.${action}`)}
            </p>
          </div>

          {action === 'reassign' && (
            <div className="space-y-2">
              <Label htmlFor="override-reassign">{t('workflow.override.reassign_target')}</Label>
              <Select value={reassignTo} onValueChange={setReassignTo} disabled={busy}>
                <SelectTrigger id="override-reassign">
                  <SelectValue placeholder={t('workflow.delegation.select_member')} />
                </SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.display}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="override-reason">
              {t('workflow.override.reason_label')}
            </Label>
            <Textarea
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder={t('workflow.override.reason_placeholder')}
              disabled={busy}
              className={cn(
                reasonValid
                  ? 'border-success/50'
                  : reason.length > 0
                  ? 'border-warning/50'
                  : '',
              )}
            />
            <p
              className={cn(
                'text-[11px]',
                reasonValid ? 'text-success' : 'text-muted-foreground',
              )}
            >
              {t('workflow.common.char_count', { chars: reason.trim().length, min: 20 })}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={busy || !reasonValid || !reassignValid}
          >
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            <ShieldAlert className="h-4 w-4 mr-2" />
            {t('workflow.override.execute')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
