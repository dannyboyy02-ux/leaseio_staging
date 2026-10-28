// ─────────────────────────────────────────────────────────────────────────
// ApprovalRuleRowMenu — the row's kebab.
//
// Reordering lives HERE and nowhere else: no drag handle exists on this
// surface, so every move is keyboard-native by construction, works on touch,
// and is a single code path with a single set of tests. No dnd-kit, no
// KeyboardSensor, no dual reorder paths to keep in sync, and no trackpad
// mis-fire writing to a live routing table.
//
// Every mutating item is a CALLBACK. This component performs no writes — in
// particular Delete is D-Q4 evidence-gated and the parent owns that check.
// ─────────────────────────────────────────────────────────────────────────

import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import type { ApprovalRuleRowPolicy } from '@/components/settings/ApprovalRuleRow';

export interface RuleRowMenuProps {
  policy: ApprovalRuleRowPolicy;
  paused: boolean;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onMoveToTop?: () => void;
  onMoveToBottom?: () => void;
  onTogglePaused?: (next: boolean) => void;
  onDelete?: () => void;
}

export function ApprovalRuleRowMenu({
  policy,
  paused,
  busy,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onMoveToBottom,
  onTogglePaused,
  onDelete,
}: RuleRowMenuProps) {
  const { t } = useAppTranslation();
  const hasOrdering = Boolean(onMoveUp || onMoveDown || onMoveToTop || onMoveToBottom);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-10 w-10"
          disabled={busy}
          /* PENDING KEY: policy_editor.list.row_actions_aria */
          aria-label={t('policy_editor.list.row_actions_aria', {
            name: policy.name,
            defaultValue: `${t('common.more_actions')}: ${policy.name}`,
          })}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem asChild>
          <Link to={`/app/settings/approval-policies/${policy.id}`}>{t('common.edit')}</Link>
        </DropdownMenuItem>
        {hasOrdering && <DropdownMenuSeparator />}
        {onMoveUp && (
          <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMoveUp()}>
            <ArrowUp className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('policy_editor.order.move_up')}
          </DropdownMenuItem>
        )}
        {onMoveDown && (
          <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMoveDown()}>
            <ArrowDown className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('policy_editor.order.move_down')}
          </DropdownMenuItem>
        )}
        {onMoveToTop && (
          <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMoveToTop()}>
            <ChevronsUp className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('policy_editor.order.move_to_top')}
          </DropdownMenuItem>
        )}
        {onMoveToBottom && (
          <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMoveToBottom()}>
            <ChevronsDown className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('policy_editor.order.move_to_bottom')}
          </DropdownMenuItem>
        )}
        {onTogglePaused && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onTogglePaused(paused)}>
              {paused ? (
                <PlayCircle className="mr-2 h-4 w-4" aria-hidden="true" />
              ) : (
                <PauseCircle className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {/* PENDING KEY: policy_editor.list.turn_on */}
              {paused
                ? t('policy_editor.list.turn_on', { defaultValue: 'Turn on' })
                : t('policy_editor.list.turn_off')}
            </DropdownMenuItem>
          </>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete()}
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('policy_editor.list.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
