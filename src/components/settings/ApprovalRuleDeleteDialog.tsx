// ─────────────────────────────────────────────────────────────────────────
// ApprovalRuleDeleteDialog — D-Q4 evidence-gated delete.
//
// A rule that has ever routed a request is part of the audit trail: deleting
// it would orphan the `lease_approval_chain.policy_id` snapshot that explains
// why a lease went where it went. So the dialog ASKS THE DATABASE FIRST and
// offers only what is actually true:
//
//   never routed anything → hard delete, stated as permanent.
//   routed at least once  → clean refusal + "Turn off instead", which stops it
//                           matching new requests and keeps the history intact.
//   check failed          → refuse and say so. Never fall through to delete on
//                           a failed read: "we couldn't tell" must not become
//                           "so we removed it".
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
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
import { Button } from '@/components/ui/button';
import { useAppTranslation } from '@/hooks/useAppTranslation';

export interface DeletableRule {
  id: string;
  name: string;
}

export interface ApprovalRuleDeleteDialogProps {
  /** The rule under consideration; null closes the dialog. */
  rule: DeletableRule | null;
  onOpenChange: (open: boolean) => void;
  /** Runs the hard delete. Only ever offered when the evidence check says the
   *  rule never routed a request. */
  onConfirmDelete: (rule: DeletableRule) => Promise<void> | void;
  /** The refusal path's one-click alternative. */
  onTurnOff: (rule: DeletableRule) => Promise<void> | void;
}

export function ApprovalRuleDeleteDialog({
  rule,
  onOpenChange,
  onConfirmDelete,
  onTurnOff,
}: ApprovalRuleDeleteDialogProps) {
  const { t } = useAppTranslation();
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!rule) setActing(false);
  }, [rule]);

  // "Has this rule ever routed a request?" — one row is enough evidence.
  const usageQuery = useQuery({
    queryKey: ['approval-policy-usage', rule?.id],
    enabled: !!rule?.id,
    // Evidence, not a cache: re-ask every time the dialog opens.
    gcTime: 0,
    staleTime: 0,
    retry: 1,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('lease_approval_chain')
        .select('id')
        .eq('policy_id', rule!.id)
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },
  });

  const checking = usageQuery.isPending;
  const checkFailed = usageQuery.isError;
  const everUsed = usageQuery.data === true;
  const canDelete = !checking && !checkFailed && !everUsed;

  const title = everUsed
    ? t('policy_editor.list.delete_in_use_title')
    : t('policy_editor.list.delete_confirm_title');

  const body = checking
    ? t('policy_editor.list.delete_checking')
    : checkFailed
      ? t('policy_editor.list.delete_check_failed')
      : everUsed
        ? t('policy_editor.list.delete_in_use_body', { name: rule?.name ?? '' })
        : t('policy_editor.list.delete_confirm_body', { name: rule?.name ?? '' });

  const run = async (fn: (r: DeletableRule) => Promise<void> | void) => {
    if (!rule) return;
    setActing(true);
    try {
      await fn(rule);
      onOpenChange(false);
    } finally {
      setActing(false);
    }
  };

  return (
    <AlertDialog open={!!rule} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-start gap-2">
            {checking ? (
              <Loader2 className="h-4 w-4 mt-0.5 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0">{title}</span>
          </AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={acting}>{t('common.cancel')}</AlertDialogCancel>
          {everUsed && (
            <Button
              type="button"
              variant="outline"
              disabled={acting}
              onClick={() => void run(onTurnOff)}
            >
              {t('policy_editor.list.deactivate_instead')}
            </Button>
          )}
          {checkFailed && (
            <Button type="button" variant="outline" onClick={() => void usageQuery.refetch()}>
              {t('policy_editor.list.retry')}
            </Button>
          )}
          {canDelete && (
            <AlertDialogAction
              disabled={acting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void run(onConfirmDelete);
              }}
            >
              {t('policy_editor.list.delete_confirm_cta')}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
