import { ReactNode } from 'react';
import { useAppTranslation } from '@/hooks/useAppTranslation';

import { SectionCard } from './SectionCard';
import { AIExtractedBadge } from './AIExtractedBadge';

interface Props {
  /** The lease record. We only need extracted_json. */
  lease: any;
}

interface ObligationDef {
  key: string;
  /** Top-level key inside extracted_json. */
  jsonKey: string;
  /** i18n path for the card title (under locked_lease.obligations.). */
  titleKey: string;
}

// Personal guarantees and assignment/sublease consent are intentionally NOT
// surfaced here: both are explicit entries in the AI extraction's RISK FLAGS
// list and always appear in the Risks tab when material. The extracted data
// still lives on the lease (extracted_json.personal_guarantees /
// .assignment_consent) for downstream exports and audit, but we don't render
// it twice in the locked-lease detail view.
const OBLIGATIONS: ObligationDef[] = [
  { key: 'permitted_use', jsonKey: 'permitted_use', titleKey: 'permitted_use' },
  { key: 'insurance', jsonKey: 'insurance_requirements', titleKey: 'insurance' },
  { key: 'maintenance', jsonKey: 'maintenance_responsibilities', titleKey: 'maintenance' },
  { key: 'holdover', jsonKey: 'holdover_terms', titleKey: 'holdover' },
  { key: 'estoppel_snda', jsonKey: 'estoppel_snda', titleKey: 'estoppel_snda' },
];

const extractedValue = (node: any): string | null => {
  if (!node) return null;
  if (typeof node === 'string') return node || null;
  if (typeof node === 'object' && 'value' in node) {
    return typeof node.value === 'string' && node.value.trim() ? node.value : null;
  }
  return null;
};

export function ObligationsTab({ lease }: Props) {
  const { t } = useAppTranslation();
  const extracted = lease?.extracted_json ?? null;

  return (
    <div className="space-y-4 mt-0">
      {OBLIGATIONS.map((ob) => {
        const value = extractedValue(extracted?.[ob.jsonKey]);
        const meta: ReactNode = value ? <AIExtractedBadge /> : null;
        return (
          <SectionCard
            key={ob.key}
            title={t(`locked_lease.obligations.${ob.titleKey}`)}
            meta={meta}
          >
            {value ? (
              <p className="text-sm text-foreground whitespace-pre-line leading-relaxed">{value}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                {t('locked_lease.obligations.empty_hint')}
              </p>
            )}
          </SectionCard>
        );
      })}
    </div>
  );
}
