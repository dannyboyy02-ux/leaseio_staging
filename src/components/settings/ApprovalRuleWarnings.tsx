// ─────────────────────────────────────────────────────────────────────────
// The two "this rule will never be used" disclosures, each with its own
// one-click fix. Both are stated in PLAIN LANGUAGE with an icon — a silent
// dead rule is the failure mode this whole redesign exists to end.
//
//   RuleNeverFiresNote     — shadowed by an earlier rule, or an impossible
//                            cost range. Shadowing offers "Check this first".
//   RetiredCriteriaBlock   — D-Q2. Region / lease type were authored, intake
//                            never collects them, so the rule can never fire.
//                            The authored values are shown READ-ONLY (never
//                            destroyed) with one-click removal of the dead
//                            criteria only.
//
// Neither component writes anything; both take callbacks.
// ─────────────────────────────────────────────────────────────────────────

import { AlertTriangle, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import type {
  RetiredCriteriaReport,
  RetiredDimension,
  RuleOverlapInfo,
} from '@/lib/approvalDescribe';
import { RowNote } from '@/components/settings/ApprovalRowPrimitives';

export interface RuleNeverFiresNoteProps {
  /** Already-localized sentence from `describeNeverFires`. */
  warning: string;
  /** Drives which one-click fix (if any) is offered. */
  reason: RuleOverlapInfo['reason'];
  disabled?: boolean;
  /** Offered only for `shadowed`: moving this rule above its shadower is the
   *  actual fix, and it is one click. */
  onMoveToTop?: () => void;
}

export function RuleNeverFiresNote({
  warning,
  reason,
  disabled,
  onMoveToTop,
}: RuleNeverFiresNoteProps) {
  const { t } = useAppTranslation();
  return (
    <RowNote
      icon={AlertTriangle}
      tone="caution"
      action={
        reason === 'shadowed' && onMoveToTop ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={disabled}
            onClick={onMoveToTop}
          >
            {t('policy_editor.order.move_to_top')}
          </Button>
        ) : undefined
      }
    >
      {warning}
    </RowNote>
  );
}

export interface RetiredCriteriaBlockProps {
  /** `describeRetiredCriteria(policy)`. */
  report: RetiredCriteriaReport;
  disabled?: boolean;
  /** D-Q2 one-click removal. Receives ONLY the dead dimensions; nothing else
   *  about the rule changes. Omit to render read-only with no fix. */
  onRemove?: (dimensions: RetiredDimension[]) => void;
}

export function RetiredCriteriaBlock({ report, disabled, onRemove }: RetiredCriteriaBlockProps) {
  const { t } = useAppTranslation();
  if (report.regions.length === 0 && report.leaseTypes.length === 0) return null;

  const removeLabel =
    report.dimensions.length === 2
      ? t('policy_editor.retired.remove_both')
      : report.dimensions[0] === 'region'
        ? t('policy_editor.retired.remove_region')
        : t('policy_editor.retired.remove_lease_type');

  return (
    <div className="space-y-1">
      {report.warning && (
        <RowNote
          icon={AlertTriangle}
          tone="caution"
          action={
            onRemove && report.dimensions.length > 0 ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                disabled={disabled}
                onClick={() => onRemove(report.dimensions)}
              >
                {removeLabel}
              </Button>
            ) : undefined
          }
        >
          {report.warning}
        </RowNote>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {report.regions.length > 0 && (
          <Badge variant="secondary" className="text-[10px] font-normal">
            <span className="font-semibold mr-1">{t('policy_editor.retired.region_label')}:</span>
            {report.regions.join(', ')}
          </Badge>
        )}
        {report.leaseTypes.length > 0 && (
          <Badge variant="secondary" className="text-[10px] font-normal">
            <span className="font-semibold mr-1">
              {t('policy_editor.retired.lease_type_label')}:
            </span>
            {report.leaseTypes.join(', ')}
          </Badge>
        )}
      </div>
      <RowNote icon={Info} tone="muted">
        {t('policy_editor.retired.readonly_hint')}
      </RowNote>
    </div>
  );
}
