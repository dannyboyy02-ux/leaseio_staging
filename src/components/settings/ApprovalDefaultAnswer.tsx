// ─────────────────────────────────────────────────────────────────────────
// The NO-RULE-MATCHED half of the answer panel, plus the shared alarm block.
//
// Split out of ApprovalAnswerPanel because this path is a different engine
// branch with different rules, and mixing it into the chain renderer is exactly
// how a surface ends up claiming a signature stage that does not exist.
//
// THREE TRUTHS, THREE DIFFERENT SENTENCES:
//   • default approvers exist  → the request routes, to named humans, with NO
//     signature stage (this path builds no chain).
//   • no defaults AND no rules → the engine APPROVES with no human at all.
//     (`no_policies` → no approvers → getApprovalRequirements both-false →
//     getInitialStatusAfterSubmission returns `approved`.)
//   • no defaults BUT rules exist → the engine turns the request away (409
//     `no_match_no_fallback`).
// Rendering the second as "blocked" would tell a finance team the gate is shut
// while it is standing open. That is the single worst copy error on this page.
// ─────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { formatLocalizedCurrency, type SupportedLocale } from '@/lib/dateFormatters';
import { describeApprover } from '@/lib/approvalDescribe';
import type { ApprovalDirectory } from '@/components/settings/approvalAnswerTypes';

/** Icon + heading + sentence + one action. Never colour alone (a11y plan). */
export function Alarm({
  title,
  body,
  cta,
  onCta,
  icon = <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />,
}: {
  title: string;
  body: string;
  cta: string;
  onCta?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        {icon}
        <div className="min-w-0 space-y-1">
          <p className="break-words text-base font-semibold">{title}</p>
          <p className="break-words text-sm text-muted-foreground">{body}</p>
        </div>
      </div>
      {onCta && (
        <Button size="sm" onClick={onCta} className="w-full sm:w-auto">
          {cta}
        </Button>
      )}
    </div>
  );
}

/**
 * The legacy default-approver route, named honestly.
 *
 * Built from describeApprover on the two role slots — NOT describeChain, which
 * would materialize an inherited signature stage and print "…and signs it too"
 * for a path that never signs.
 *
 * The financial clause states the threshold as the lease's TOTAL OVER THE WHOLE
 * TERM, because that is what `approvalRouting.ts` compares `approval_threshold`
 * against (`calc_total_commitment`). Calling it annual would be a fresh untruth
 * about a number a controller acts on.
 */
export function DefaultRouteAnswer({
  legacy,
  directory,
  approvalThreshold,
  language,
}: {
  legacy?: { has_manager_approver: boolean; has_financial_approver: boolean };
  directory: ApprovalDirectory;
  approvalThreshold: number | null;
  language: SupportedLocale;
}) {
  const { t } = useAppTranslation();
  const { members, roleHolders } = directory;

  const manager = describeApprover(
    { approver_user_id: null, approver_role: 'manager_approver' },
    members,
    roleHolders,
  );
  const financial = describeApprover(
    { approver_user_id: null, approver_role: 'financial_approver' },
    members,
    roleHolders,
  );
  const hasManager = Boolean(legacy?.has_manager_approver) && !manager.blocksRouting;
  const hasFinancial = Boolean(legacy?.has_financial_approver) && !financial.blocksRouting;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('policy_editor.hero.answer_eyebrow', { defaultValue: 'Who approves it' })}
        </p>
        <div className="mt-1 space-y-1 break-words text-xl font-semibold sm:text-2xl">
          {hasManager && (
            <p>
              {t('policy_editor.hero.default_manager', {
                name: manager.text,
                defaultValue: '{{name}} approves.',
              })}
            </p>
          )}
          {hasFinancial && (
            <p>
              {approvalThreshold != null
                ? t('policy_editor.hero.default_financial_threshold', {
                    name: financial.text,
                    amount: formatLocalizedCurrency(approvalThreshold, language),
                    defaultValue:
                      "{{name}} also approves when the lease's total over the whole term is over {{amount}}.",
                  })
                : t('policy_editor.hero.default_financial_plain', {
                    name: financial.text,
                    defaultValue: 'Then {{name}} approves.',
                  })}
            </p>
          )}
        </div>
      </div>

      {!hasFinancial && (
        <p className="text-sm text-muted-foreground">
          {t('policy_editor.list.defaults_no_financial_warning')}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t('policy_editor.hero.default_no_signing', {
          defaultValue: 'No signing step — leases routed here skip “sign the deal”.',
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('policy_editor.hero.because_default', {
          defaultValue:
            'No rule covers this one, so it goes to the people you picked for everything else.',
        })}
      </p>
    </div>
  );
}

/** Nothing would route the request. Which of the two truths it is depends on
 *  whether any active rule exists at all — see the header note. */
export function NoRouteAnswer({
  hasActiveRules,
  onPickDefaultApprovers,
}: {
  hasActiveRules: boolean;
  onPickDefaultApprovers?: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <Alarm
      title={
        hasActiveRules
          ? t('policy_editor.hero.no_route_title', {
              defaultValue: "A request like this can't be submitted",
            })
          : t('policy_editor.hero.auto_title', {
              defaultValue: 'Nobody is reviewing lease requests',
            })
      }
      body={
        hasActiveRules
          ? t('policy_editor.hero.no_route_body', {
              defaultValue:
                'It fits none of your rules and nobody is set up for everything else, so it will be turned away at submission.',
            })
          : t('policy_editor.hero.auto_body', {
              defaultValue:
                'Every request is approved the moment it is submitted, because no approvers are assigned.',
            })
      }
      cta={t('policy_editor.hero.pick_approvers_cta', { defaultValue: 'Pick who approves' })}
      onCta={onPickDefaultApprovers}
    />
  );
}
