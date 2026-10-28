// ─────────────────────────────────────────────────────────────────────────
// ApprovalAnswerPanel — the ANSWER half of the approval answer strip.
//
// It renders one resolved answer and nothing else: no inputs, no queries, no
// debounce. That split is deliberate — the list page and (later) the editor's
// live strip pose the question differently but must answer it identically, so
// the answer has exactly one implementation.
//
// EVERY name on this surface comes from describeApprover / describeChain
// (src/lib/approvalDescribe.ts), which carries the hard guarantee that no raw
// or truncated UUID and no "Anyone with role" can reach a user. This file must
// never render `approver_user_id`, `policy_id`, or a role token directly.
//
// The legacy default-approver path is described with describeApprover on its
// two role slots and NEVER with describeChain — that path builds no chain and
// has no signature stage, and describeChain would materialize an inherited
// stage 2 and print "…and signs it too" for a path that never signs.
//
// i18n NOTE: the keys marked NEW below are not in the central locale batch yet
// (see the hand-off report). They carry English `defaultValue`s so the surface
// is never a raw key path; delete the defaults once the keys land in en+es.
// ─────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { type SupportedLocale } from '@/lib/dateFormatters';
import { describeChain } from '@/lib/approvalDescribe';
import {
  isMatched,
  type ApprovalDirectory,
  type PreviewResolution,
} from '@/components/settings/approvalAnswerTypes';
import {
  Alarm,
  DefaultRouteAnswer,
  NoRouteAnswer,
} from '@/components/settings/ApprovalDefaultAnswer';

// The RPC result shape + the people directory live in approvalAnswerTypes so
// this panel and the default-route renderer can share them without a cycle.
// Re-exported here because callers naturally import them alongside the panel.
export type {
  PreviewChainStep,
  MatchedResolution,
  UnmatchedResolution,
  PreviewResolution,
  ApprovalDirectory,
} from '@/components/settings/approvalAnswerTypes';

export interface ApprovalAnswerPanelProps {
  result: PreviewResolution | null;
  /** A newer resolution is in flight. The previous answer STAYS, dimmed. */
  busy: boolean;
  failed: boolean;
  onRetry: () => void;
  directory: ApprovalDirectory;
  /** Distinguishes "no rules at all → auto-approved" from "rules exist, none
   *  fit → blocked". The engine treats these differently and so must the copy. */
  hasActiveRules: boolean;
  /** workspaces.approval_threshold — compared by the engine against the total
   *  cash commitment across the FULL TERM, never against the annual cost. */
  approvalThreshold: number | null;
  language: SupportedLocale;
  onOpenRule?: (ruleId: string) => void;
  onPickDefaultApprovers?: () => void;
}

export function ApprovalAnswerPanel({
  result,
  busy,
  failed,
  onRetry,
  directory,
  hasActiveRules,
  approvalThreshold,
  language,
  onOpenRule,
  onPickDefaultApprovers,
}: ApprovalAnswerPanelProps) {
  const { t } = useAppTranslation();
  const { members, roleHolders } = directory;

  const shell = (children: ReactNode, tone: 'normal' | 'alarm' = 'normal') => (
    <div
      aria-live="polite"
      aria-atomic="true"
      aria-busy={busy || undefined}
      className={cn(
        'rounded-lg border p-4 sm:p-5',
        tone === 'alarm' ? 'border-destructive/50 bg-destructive/5' : 'bg-muted/30',
        busy && 'opacity-60 transition-opacity duration-150',
      )}
    >
      {children}
    </div>
  );

  if (failed) {
    return shell(
      <div className="space-y-3">
        <p className="flex items-start gap-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('policy_editor.hero.error')}</span>
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('policy_editor.hero.retry')}
        </Button>
      </div>,
      'alarm',
    );
  }

  if (!result) {
    return shell(
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('policy_editor.hero.answer_eyebrow', { defaultValue: 'Who approves it' })}
        </p>
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
        <p className="sr-only">{t('policy_editor.hero.loading')}</p>
      </div>,
    );
  }

  // ── matched a rule ─────────────────────────────────────────────────────
  if (isMatched(result)) {
    if (result.empty_chain) {
      return shell(
        <Alarm
          title={t('policy_editor.hero.empty_chain_title', {
            defaultValue: "This request can't be submitted",
          })}
          body={t('policy_editor.hero.empty_chain_body', {
            name: result.policy_name,
            defaultValue: 'The rule «{{name}}» has nobody in it.',
          })}
          cta={t('policy_editor.hero.empty_chain_cta', { defaultValue: 'Add an approver' })}
          onCta={onOpenRule ? () => onOpenRule(result.policy_id) : undefined}
        />,
        'alarm',
      );
    }

    const chain = describeChain(result.chain, members, roleHolders, {
      signatorInherited: result.signator_inherited,
    });
    const tied = result.tie?.tied_policies?.[0];

    return shell(
      <div className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('policy_editor.hero.answer_eyebrow', { defaultValue: 'Who approves it' })}
          </p>
          <p
            className={cn(
              'mt-1 text-xl font-semibold break-words sm:text-2xl',
              chain.blocked && 'text-destructive',
            )}
          >
            {chain.blocked && (
              <ShieldAlert className="mr-1.5 inline h-5 w-5 align-[-3px]" aria-hidden="true" />
            )}
            {chain.sentence}
          </p>
        </div>

        <ul className="space-y-3">
          {chain.stages.map((stage, index) => (
            <li key={stage.stage} className="space-y-0.5">
              <p className="text-xs font-medium text-muted-foreground">
                {index + 1} ·{' '}
                {stage.stage === 'concept'
                  ? t('policy_editor.stage1_primary')
                  : t('policy_editor.stage2_primary')}{' '}
                —{' '}
                {stage.stage === 'concept'
                  ? t('policy_editor.stage1_secondary')
                  : t('policy_editor.stage2_secondary')}
              </p>
              <p className="break-words text-sm">{stage.text}</p>
              {stage.note && <p className="text-xs text-muted-foreground">{stage.note}</p>}
            </li>
          ))}
        </ul>

        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">
            {t('policy_editor.hero.because_prefix', { defaultValue: 'Because of your rule' })}{' '}
            <RuleButton
              name={result.policy_name}
              onClick={onOpenRule ? () => onOpenRule(result.policy_id) : undefined}
              label={t('policy_editor.hero.open_rule_aria', {
                name: result.policy_name,
                defaultValue: 'Open the rule «{{name}}»',
              })}
            />
          </p>
          {tied && (
            <p className="text-xs text-muted-foreground">
              {t('policy_editor.hero.tie_note', {
                name: tied.name,
                defaultValue:
                  '«{{name}}» fits this request too. This one wins because it was created first.',
              })}
            </p>
          )}
        </div>
      </div>,
      chain.blocked ? 'alarm' : 'normal',
    );
  }

  // ── no rule matched ────────────────────────────────────────────────────
  if (result.fallback === 'legacy_default') {
    return shell(
      <DefaultRouteAnswer
        legacy={result.legacy}
        directory={directory}
        approvalThreshold={approvalThreshold}
        language={language}
      />,
    );
  }

  return shell(
    <NoRouteAnswer
      hasActiveRules={hasActiveRules}
      onPickDefaultApprovers={onPickDefaultApprovers}
    />,
    'alarm',
  );
}

/** The one-click path from a wrong answer to the rule that produced it. */
function RuleButton({
  name,
  label,
  onClick,
}: {
  name: string;
  label: string;
  onClick?: () => void;
}) {
  if (!onClick) return <span className="font-medium text-foreground">«{name}»</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="rounded-sm font-medium text-foreground underline underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      «{name}»
    </button>
  );
}
