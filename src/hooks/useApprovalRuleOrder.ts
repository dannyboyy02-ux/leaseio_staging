// ─────────────────────────────────────────────────────────────────────────
// useApprovalRuleOrder — the list page's ONE reorder path.
//
// Order is expressed as INTENT (move up / move down / check this first /
// check this last) and submitted as the FULL intended id array to
// `set_approval_policy_order`. Nothing here computes a priority integer: a
// client-computed midpoint from possibly-stale neighbours lets two concurrent
// admins interleave into an order neither intended, silently.
//
// There is deliberately no drag path. Every move is a menu item, so reordering
// is keyboard-native by construction, works on touch, and has one code path.
//
// CONCURRENCY: the payload is set-checked client-side (fast path) and again
// inside the RPC transaction (the guarantee). A stale set never reorders — it
// raises `stale_policy_order`, and the user is told to reload rather than
// having a rule land somewhere they did not choose.
// ─────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import {
  moveDown,
  moveToBottom,
  moveToTop,
  moveUp,
  validateOrderSet,
} from '@/lib/approvalPolicyOrder';

export type RuleMove = 'up' | 'down' | 'top' | 'bottom';

const APPLY: Record<RuleMove, (ids: readonly string[], id: string) => string[]> = {
  up: moveUp,
  down: moveDown,
  top: moveToTop,
  bottom: moveToBottom,
};

/** The RPC is not in the generated types yet (migration 20260719121000), so it
 *  is called through one narrow local signature rather than an `as any` that
 *  would also silence the argument shape. */
type OrderRpc = (
  fn: 'set_approval_policy_order',
  args: { p_workspace_id: string; p_ordered_ids: string[] },
) => Promise<{ error: { message: string } | null }>;

export interface UseApprovalRuleOrderArgs {
  workspaceId: string | null;
  /** Rule ids in the DISPLAYED order, which is the engine's order. */
  orderedIds: readonly string[];
  /** id → rule name, for the announcement and the Undo toast. */
  names: ReadonlyMap<string, string>;
  /** Refetch after a stale-set rejection, or after a successful write. */
  onReload: () => void;
  /** Called with the moved rule's id after a successful write, so the page can
   *  return focus to that row. */
  onMoved?: (id: string) => void;
}

export interface UseApprovalRuleOrder {
  busy: boolean;
  /** Text for the page's `aria-live="polite"` region. */
  announcement: string;
  move: (kind: RuleMove, id: string) => void;
}

export function useApprovalRuleOrder({
  workspaceId,
  orderedIds,
  names,
  onReload,
  onMoved,
}: UseApprovalRuleOrderArgs): UseApprovalRuleOrder {
  const { t } = useAppTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const submit = useCallback(
    async (nextIds: string[], movedId: string, previous: readonly string[] | null) => {
      if (!workspaceId) return;

      const validation = validateOrderSet(orderedIds, nextIds);
      if (!validation.ok) {
        toast.error(t('policy_editor.order.error_stale'), {
          action: { label: t('policy_editor.order.reload'), onClick: onReload },
        });
        onReload();
        return;
      }

      setBusy(true);
      const { error } = await (supabase.rpc as unknown as OrderRpc)(
        'set_approval_policy_order',
        { p_workspace_id: workspaceId, p_ordered_ids: nextIds },
      );
      setBusy(false);

      if (error) {
        const message = error.message ?? '';
        if (message.includes('stale_policy_order')) {
          toast.error(t('policy_editor.order.error_stale'), {
            action: { label: t('policy_editor.order.reload'), onClick: onReload },
          });
          onReload();
        } else if (message.includes('workspace_not_live')) {
          toast.error(t('policy_editor.order.error_not_live'));
        } else if (/forbidden/i.test(message)) {
          toast.error(t('policy_editor.order.error_forbidden'));
        } else {
          toast.error(t('policy_editor.order.toast_failed'));
        }
        return;
      }

      const name = names.get(movedId) ?? '';
      const moved = t('policy_editor.order.moved_announcement', {
        name,
        n: nextIds.indexOf(movedId) + 1,
        total: nextIds.length,
      });
      setAnnouncement(moved);

      await queryClient.invalidateQueries({ queryKey: ['approval-policies', workspaceId] });
      await queryClient.invalidateQueries({ queryKey: ['approval-answer-rules', workspaceId] });

      // Undo names what moved and where it went — an order change with an
      // anonymous "Undo" is not reviewable.
      toast.success(t('policy_editor.order.toast_saved'), {
        description: moved,
        action: previous
          ? {
              label: t('common.undo'),
              onClick: () => void submit([...previous], movedId, null),
            }
          : undefined,
      });
      onMoved?.(movedId);
    },
    [workspaceId, orderedIds, names, onReload, onMoved, queryClient, t],
  );

  const move = useCallback(
    (kind: RuleMove, id: string) => {
      if (busy || !workspaceId) return;
      const current = [...orderedIds];
      const next = APPLY[kind](current, id);
      // A boundary move is a no-op: do not spend a write or an audit row on it.
      if (next.length === current.length && next.every((x, i) => x === current[i])) return;
      void submit(next, id, current);
    },
    [busy, workspaceId, orderedIds, submit],
  );

  return { busy, announcement, move };
}
