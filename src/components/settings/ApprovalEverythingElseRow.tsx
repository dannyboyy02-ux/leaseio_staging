// ─────────────────────────────────────────────────────────────────────────
// ApprovalEverythingElseRow — the PERMANENT, undeletable last row.
//
// It is not a UI convenience. It is the visible proof of the engine contract
// that no lease enters the repository without a named human: a finance team
// can establish that at a glance, which makes this row a compliance-adjacent
// artifact. It is never absent, never draggable, never deletable, has no
// switch and no star, and it is distinguished by a LABEL and a dashed border,
// not by tint alone.
//
// WHY IT DOES NOT CALL describeChain
// The default-approver route builds NO approval chain — `resolve-approval-
// chain` calls getApprovalRequirements() and flips the lifecycle directly.
// Feeding synthesized steps into describeChain would materialize an inherited
// signature stage and print "…and signs it too" for a path that never signs.
// So this row composes its own copy from `describeApprover` on its two slots,
// exactly as approvalDescribe's own doc comment instructs.
//
// THE TWO TRUTHS THIS ROW MUST NOT CONFUSE (security-relevant):
//   • no rules AND no default approvers → the engine AUTO-APPROVES. The gate
//     is standing open. Different verb, different sentence.
//   • rules exist, none match, no default approvers → the engine 409s and the
//     request is BLOCKED at submission.
// Telling an admin "blocked" in the state that actually auto-approves would be
// the single worst copy error on this page.
//
// THRESHOLD WORDING: `approvalRouting.ts` compares `approval_threshold`
// against TOTAL CASH COMMITMENT ACROSS THE FULL TERM, not annual cost. The
// shipped `workflow.request.review_threshold` string says exactly that and is
// reused verbatim here so the number a controller acts on is never relabelled.
//
// PENDING LOCALE KEYS are marked inline and listed in this component's report.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo, type Ref } from 'react';
import { AlertTriangle, Anchor, Info, PenOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import {
  describeApprover,
  type ApproverDescription,
  type MemberLike,
  type RoleHolderMap,
} from '@/lib/approvalDescribe';
import { RowNote, RowShell } from '@/components/settings/ApprovalRowPrimitives';

/** Which of the two legacy default slots are actually filled. Exported so the
 *  page can reuse the same three-state vocabulary in the hero. */
export type CatchAllCoverage = 'assigned' | 'partial' | 'nobody';

export interface ApprovalEverythingElseRowProps {
  members: readonly MemberLike[];
  /** From `buildRoleHolderMap(workspace_roles rows)`. The RPC returns only
   *  `legacy: {has_manager_approver, has_financial_approver}` booleans — no
   *  names — so the people come from here.
   *
   *  REQUIRED, deliberately: an absent map resolves both slots to "nobody",
   *  which is this row's DESTRUCTIVE state. An optional prop would let a
   *  still-loading page tell an admin that lease requests are unreviewed when
   *  they are not. Render the row only once `workspace_roles` has resolved. */
  roleHolders: RoleHolderMap;
  /** `workspaces.approval_threshold`. Compared against the lease's TOTAL cash
   *  commitment over the whole term — never against an annual figure. */
  approvalThreshold?: number | null;
  /** `workspaces.covenant_threshold`. When set, covenant-flagged leases always
   *  get financial review regardless of the amount. */
  covenantThreshold?: number | null;
  /** true when the workspace has at least one approval rule. This is what
   *  separates AUTO-APPROVED from BLOCKED — see the header note. */
  hasAnyRules: boolean;
  /** Wire this to where a SOLO admin can actually set approvers (D-Q3: the
   *  approval-roles editor is hidden below two members today). It is a prop
   *  precisely so this row can never dead-end. */
  onPickApprovers: () => void;
  /** The hero's "Pick people" action scrolls to and focuses this button. */
  ctaRef?: Ref<HTMLButtonElement>;
  /** Match the rule rows' gutter so the column edges line up. */
  wideGutter?: boolean;
  className?: string;
  id?: string;
}

export function ApprovalEverythingElseRow({
  members,
  roleHolders,
  approvalThreshold = null,
  covenantThreshold = null,
  hasAnyRules,
  onPickApprovers,
  ctaRef,
  wideGutter = false,
  className,
  id,
}: ApprovalEverythingElseRowProps) {
  const { t, language } = useAppTranslation();

  // describeApprover renders through the i18next singleton at call time, so
  // the memo keys on the active language.
  const manager = useMemo<ApproverDescription>(
    () => describeApprover({ approver_user_id: null, approver_role: 'manager_approver' }, members, roleHolders),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, roleHolders, language],
  );
  const financial = useMemo<ApproverDescription>(
    () => describeApprover({ approver_user_id: null, approver_role: 'financial_approver' }, members, roleHolders),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, roleHolders, language],
  );

  const managerFilled = !manager.blocksRouting;
  const financialFilled = !financial.blocksRouting;
  const coverage: CatchAllCoverage =
    managerFilled && financialFilled ? 'assigned' : managerFilled || financialFilled ? 'partial' : 'nobody';

  const thresholdAmount =
    approvalThreshold == null ? null : formatLocalizedCurrency(approvalThreshold, language);

  return (
    <RowShell
      id={id}
      wideGutter={wideGutter}
      className={cn('border-dashed border-t-2 bg-muted/40', className)}
      gutter={<Anchor className="h-3.5 w-3.5" aria-hidden="true" />}
    >
      {/* Line 1 — the label, plus the word that makes its position explicit
          rather than implied by placement alone. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{t('policy_editor.list.everything_else_label')}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {/* PENDING KEY: policy_editor.list.everything_else_always_last */}
          {t('policy_editor.list.everything_else_always_last', { defaultValue: 'Always last' })}
        </span>
      </div>

      <p className="text-xs text-muted-foreground break-words">
        {t('policy_editor.list.everything_else_routes')}
      </p>

      {coverage === 'nobody' ? (
        <NobodyPanel
          hasAnyRules={hasAnyRules}
          onPickApprovers={onPickApprovers}
          ctaRef={ctaRef}
        />
      ) : (
        <div className="space-y-1.5">
          {/* The people — never clamped, never truncated. */}
          <p className="text-sm text-foreground break-words" title={manager.fullNames.join(', ') || undefined}>
            {t('policy_editor.list.everything_else_manager', {
              name: managerFilled
                ? manager.text
                : t('policy_editor.list.everything_else_slot_unassigned'),
            })}
          </p>
          <p
            className={cn('text-sm break-words', financialFilled ? 'text-foreground' : 'text-muted-foreground')}
            title={financial.fullNames.join(', ') || undefined}
          >
            {t('policy_editor.list.everything_else_financial', {
              name: financialFilled
                ? financial.text
                : t('policy_editor.list.everything_else_slot_unassigned'),
            })}
          </p>

          {/* Financial review only applies when a financial approver exists —
              so a missing one is a real routing gap, stated in words. */}
          {!financialFilled && (
            <RowNote icon={AlertTriangle} tone="caution">
              {t('policy_editor.list.defaults_no_financial_warning')}
            </RowNote>
          )}

          {financialFilled && thresholdAmount && (
            <RowNote icon={Info} tone="muted">
              {t('workflow.request.review_threshold', { amount: thresholdAmount })}
            </RowNote>
          )}

          {financialFilled && covenantThreshold != null && (
            <RowNote icon={Info} tone="muted">
              {t('workflow.request.review_covenant')}
            </RowNote>
          )}

          <div className="relative z-10">
            <Button
              type="button"
              ref={ctaRef}
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={onPickApprovers}
            >
              {t('policy_editor.list.everything_else_edit')}
            </Button>
          </div>
        </div>
      )}

      {/* True in EVERY state, and a real reason to write a rule: this path has
          no signature stage at all. */}
      <RowNote icon={PenOff} tone="muted">
        {/* PENDING KEY: policy_editor.list.everything_else_no_signing */}
        {t('policy_editor.list.everything_else_no_signing', {
          defaultValue: 'No signing step — leases routed here skip "sign the deal".',
        })}
      </RowNote>
    </RowShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The destructive state. Two different truths, two different verbs.
// ─────────────────────────────────────────────────────────────────────────

function NobodyPanel({
  hasAnyRules,
  onPickApprovers,
  ctaRef,
}: {
  hasAnyRules: boolean;
  onPickApprovers: () => void;
  ctaRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useAppTranslation();

  // hasAnyRules === false → the engine approves with no human at all.
  // hasAnyRules === true  → the engine 409s and the request never enters.
  const title = hasAnyRules
    ? t('policy_editor.list.no_defaults_warning_title')
    : // PENDING KEY: policy_editor.list.everything_else_auto_title
      t('policy_editor.list.everything_else_auto_title', {
        defaultValue: 'Nobody is reviewing lease requests',
      });
  const body = hasAnyRules
    ? t('policy_editor.list.defaults_missing_warning')
    : t('policy_editor.list.everything_else_auto');

  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-2">
      <p className="flex items-start gap-1.5 text-sm font-medium text-destructive break-words">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span className="min-w-0">{title}</span>
      </p>
      <p className="text-xs text-destructive/90 break-words">{body}</p>
      <div className="relative z-10">
        <Button
          type="button"
          ref={ctaRef}
          variant="destructive"
          size="sm"
          className="w-full sm:w-auto"
          onClick={onPickApprovers}
        >
          {t('policy_editor.list.defaults_missing_cta')}
        </Button>
      </div>
    </div>
  );
}
