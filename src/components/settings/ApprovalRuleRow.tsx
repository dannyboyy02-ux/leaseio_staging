// ─────────────────────────────────────────────────────────────────────────
// ApprovalRuleRow — ONE approval rule, told as a plain sentence that ends in
// the PEOPLE.
//
// Deliberately NOT rendered (all removed by the redesign): the `priority N`
// badge, the ⭐ default-fallback badge, the version number, "Updated Jun 15,
// 2026", the five Asset:/Type:/Dept:/Region:/Annual: chips, the inline Active
// switch, the 32px pencil, the copy icon, the description. None of them
// answer the only question this screen exists to answer.
//
// HARD RULES
//  • The approver line is NEVER clamped or truncated. A five-approver chain
//    wraps to three lines and that visible length is honest signal the rule is
//    over-built. `line-clamp`/`truncate` appear nowhere in this file.
//  • Every state is stated in WORDS with an icon — paused, unfilled role,
//    shadowed, dead criteria. Never opacity or color alone.
//  • Approver prose comes ONLY from describeChain/describeApprover, which
//    guarantee a raw UUID can never reach the screen.
//
// i18n: describeChain renders through the i18next singleton at CALL TIME, so
// every memo below keys on the active language.
//
// PENDING LOCALE KEYS (reported to the locale owner; referenced with an
// explicit defaultValue so the row degrades to a correct sentence until they
// land): policy_editor.list.paused_badge, .paused_explainer, .turn_on,
// .row_actions_aria. Nothing else here hardcodes a user-facing string.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import type { AssetTypeOption } from '@/lib/assetTypes';
import {
  describeChain,
  describeNeverFires,
  describeRetiredCriteria,
  type DescribableStep,
  type MemberLike,
  type RoleHolderMap,
  type RuleOverlapInfo,
} from '@/lib/approvalDescribe';
import { RowNote, RowShell } from '@/components/settings/ApprovalRowPrimitives';
import { ApprovalRuleRowMenu } from '@/components/settings/ApprovalRuleRowMenu';
import {
  RetiredCriteriaBlock,
  RuleNeverFiresNote,
} from '@/components/settings/ApprovalRuleWarnings';
import { buildMatchSentence } from '@/components/settings/approvalMatchSentence';

/** The rule columns this row reads. Structurally compatible with the
 *  `approval_policies` row the list page already selects. */
export interface ApprovalRuleRowPolicy {
  id: string;
  name: string;
  is_active: boolean;
  match_asset_types: string[];
  match_lease_types: string[];
  match_departments: string[];
  match_regions: string[];
  match_min_annual_cost: number | null;
  match_max_annual_cost: number | null;
}

export interface ApprovalRuleRowProps {
  policy: ApprovalRuleRowPolicy;
  /** `approval_chain_steps` for THIS policy only. Any order. */
  steps: readonly DescribableStep[];
  members: readonly MemberLike[];
  /** From `buildRoleHolderMap(workspace_roles rows)`. REQUIRED, deliberately:
   *  an absent map makes every role step resolve to "nobody holds this role",
   *  so an optional prop would let a still-loading page raise a false alarm
   *  about a rule that is fine. Render the row only once the map exists. */
  roleHolders: RoleHolderMap;
  /** `findShadowedRules(rules).byRuleId.get(policy.id)`. Omit when unknown —
   *  the D-Q2 dead-criteria disclosure is still computed locally. */
  overlap?: RuleOverlapInfo | null;
  /** 1-based position. OMIT ENTIRELY when no two active rules can co-match:
   *  the gutter narrows and shows `•`, and the accessible name drops the
   *  position, so the order model recedes where it decides nothing. */
  ordinal?: number;
  /** Total rules in the ordered list. Required when `ordinal` is given. */
  ordinalTotal?: number;
  /** Workspace-resolved asset-type options, so the match sentence speaks the
   *  editor's vocabulary. Falls back to the built-ins. */
  assetTypeOptions?: AssetTypeOption[];
  /** Target of the whole-row overlay link. */
  editHref: string;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** Disables every mutating menu item (a save is in flight, or the workspace
   *  is read-only). */
  busy?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onMoveToTop?: () => void;
  onMoveToBottom?: () => void;
  /** `next` is the intended `is_active`. */
  onTogglePaused?: (next: boolean) => void;
  /** D-Q4: the parent runs the evidence check (has this rule ever routed a
   *  request?) and decides between hard-delete and "turn it off instead". */
  onDelete?: () => void;
  className?: string;
}

export function ApprovalRuleRow({
  policy,
  steps,
  members,
  roleHolders,
  overlap,
  ordinal,
  ordinalTotal,
  assetTypeOptions,
  editHref,
  canMoveUp = true,
  canMoveDown = true,
  busy = false,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onMoveToBottom,
  onTogglePaused,
  onDelete,
  className,
}: ApprovalRuleRowProps) {
  const { t, language } = useAppTranslation();
  const paused = !policy.is_active;
  const showOrdinal = typeof ordinal === 'number';

  const matchSentence = useMemo(
    () => buildMatchSentence(policy, language, assetTypeOptions),
    [policy, language, assetTypeOptions],
  );

  // Authored data, so `signatorInherited` is DERIVED, not passed — an
  // inherited stage 2 is described as inherited, never as chosen.
  const chain = useMemo(
    () => describeChain(steps, members, roleHolders),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, members, roleHolders, language],
  );

  const retired = useMemo(
    () => describeRetiredCriteria(policy),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [policy.match_regions, policy.match_lease_types, language],
  );

  // Retired criteria carry their own block (values + removal CTA), so only the
  // other never-fires causes come through here — no duplicated sentence.
  const overlapWarning =
    overlap && overlap.neverFires && overlap.reason !== 'retired_criteria'
      ? describeNeverFires(overlap, policy)
      : null;
  const neverFires = Boolean(overlap?.neverFires) || Boolean(retired.warning);

  // #209 — "Never used" is only TRUE when the rule is genuinely unreachable.
  // A rule retired on REGION alone is not: intake doesn't collect region, so it
  // can't match at submission, but `LeaseReview.tsx:730` writes `leases.region`
  // and region triggers a reroute — so it CAN apply later. `lease_type` is
  // genuinely never written, so a rule needing one really is dead. Shadowed
  // rules (an earlier rule fully covers them) are dead too.
  const onlyRegionRetired =
    Boolean(retired.warning) &&
    !overlap?.neverFires &&
    retired.dimensions.length === 1 &&
    retired.dimensions[0] === 'region';

  const rowLabel = showOrdinal
    ? `${t('common.edit')}: ${policy.name}. ${t('policy_editor.order.checked_position', {
        n: ordinal,
        total: ordinalTotal ?? ordinal,
      })}`
    : `${t('common.edit')}: ${policy.name}`;

  return (
    <RowShell
      wideGutter={showOrdinal}
      className={className}
      gutter={
        // A paused rule is not checked at all, so it never shows a number.
        <span aria-hidden="true">{showOrdinal ? (paused ? '—' : ordinal) : '•'}</span>
      }
      overlay={
        <Link
          to={editHref}
          className="absolute inset-0 z-[1] rounded-md focus:outline-none"
          aria-label={rowLabel}
        >
          <span className="sr-only">{rowLabel}</span>
        </Link>
      }
      trailing={
        <ApprovalRuleRowMenu
          policy={policy}
          paused={paused}
          busy={busy}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onMoveToTop={onMoveToTop}
          onMoveToBottom={onMoveToBottom}
          onTogglePaused={onTogglePaused}
          onDelete={onDelete}
        />
      }
    >
      {/* Line 1 — the name, plus word-bearing status pills. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn('text-sm font-medium break-words', paused && 'text-muted-foreground')}>
          {policy.name}
        </span>
        {paused && (
          <Badge variant="outline" className="gap-1 text-[10px] font-normal">
            <PauseCircle className="h-3 w-3" aria-hidden="true" />
            {t('policy_editor.list.paused_badge', { defaultValue: 'Paused' })}
          </Badge>
        )}
        {neverFires && (
          <Badge
            variant="outline"
            className="gap-1 text-[10px] font-normal text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">
              {t(
                onlyRegionRetired
                  ? 'policy_editor.list.not_at_submission_aria'
                  : 'policy_editor.list.never_used_aria',
              )}
            </span>
            <span aria-hidden="true">
              {t(
                onlyRegionRetired
                  ? 'policy_editor.list.not_at_submission_badge'
                  : 'policy_editor.list.never_used_badge',
              )}
            </span>
          </Badge>
        )}
      </div>

      {/* Line 2 — the match sentence, read-only, in the editor's grammar. */}
      <p className="text-xs text-muted-foreground break-words">{matchSentence}</p>

      {/* Line 3 — THE PEOPLE. Never clamped, never truncated. */}
      <p
        className={cn(
          'text-sm break-words',
          chain.blocked
            ? 'text-destructive font-medium'
            : paused
              ? 'text-muted-foreground'
              : 'text-foreground',
        )}
        title={chain.stages.flatMap((s) => s.names).join(', ') || undefined}
      >
        {chain.blocked && (
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
        )}
        {chain.sentence}
      </p>

      {/* A role nobody holds: the request silently STOPS there. Said out loud. */}
      {!chain.blocked &&
        chain.cautions.map((c, i) => (
          <RowNote key={`${c.role ?? 'step'}-${i}`} icon={AlertTriangle} tone="caution">
            {c.text}
          </RowNote>
        ))}

      {paused && (
        <RowNote icon={PauseCircle} tone="muted">
          {t('policy_editor.list.paused_explainer', {
            defaultValue: 'Paused — requests like this fall through to the next rule that fits.',
          })}
        </RowNote>
      )}

      {overlapWarning && (
        <RuleNeverFiresNote
          warning={overlapWarning}
          reason={overlap?.reason ?? null}
          disabled={busy}
          onMoveToTop={onMoveToTop}
        />
      )}

      <RetiredCriteriaBlock report={retired} />
    </RowShell>
  );
}
