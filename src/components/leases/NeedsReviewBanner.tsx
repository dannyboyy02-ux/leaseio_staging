import { AlertTriangle, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { getFieldConfidence, confidenceTier } from '@/lib/extractedFieldHelpers';
import { LOW_CONFIDENCE_THRESHOLD } from '@/types/workflow';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface NeedsReviewBannerProps {
  landlordName: string | null;
  tenantName: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  /**
   * Live per-field confidence source (the lease's `extracted_json`). This
   * banner used to read `lease.confidence_scores`, a column the extraction
   * pipeline never populates — so the low-confidence warning could never
   * fire. It now reads the same `extracted_json[field].confidence` (0–1
   * scale) that the field badges and the LeaseReview review-gate use.
   */
  extractedJson?: Record<string, any> | null;
  className?: string;
}

const TIER1_FIELDS = [
  { key: 'landlord_name', label: 'Landlord Name', dataKey: 'landlordName' },
  { key: 'tenant_name', label: 'Tenant Name', dataKey: 'tenantName' },
  { key: 'lease_start', label: 'Lease Start Date', dataKey: 'leaseStart' },
  { key: 'lease_end', label: 'Lease End Date', dataKey: 'leaseEnd' },
] as const;

// LOW_CONFIDENCE_THRESHOLD is on the 0–100 scale; getFieldConfidence returns
// 0–1, so compare against the fractional cutoff (matches LeaseReview's gate).
const LOW_CONFIDENCE_CUTOFF = LOW_CONFIDENCE_THRESHOLD / 100;

export function NeedsReviewBanner({
  landlordName,
  tenantName,
  leaseStart,
  leaseEnd,
  extractedJson,
  className,
}: NeedsReviewBannerProps) {
  const { t } = useAppTranslation();

  const fieldValues: Record<string, string | null> = {
    landlordName,
    tenantName,
    leaseStart,
    leaseEnd,
  };

  // Missing Tier-1 fields.
  const missingFields = TIER1_FIELDS.filter(
    (field) => !fieldValues[field.dataKey]
  );

  // Low-confidence Tier-1 fields that DO have a value (missing ones are
  // already surfaced above). Reads the live extracted_json confidence and
  // carries the shared tier so the icon severity matches the field badge.
  const lowConfidenceFields = TIER1_FIELDS.flatMap((field) => {
    if (!fieldValues[field.dataKey]) return [];
    const conf = getFieldConfidence(extractedJson ?? null, field.key);
    if (conf === null || conf >= LOW_CONFIDENCE_CUTOFF) return [];
    return [{
      key: field.key,
      label: field.label,
      pct: Math.round(conf * 100),
      tier: confidenceTier(conf),
    }];
  });

  const hasIssues = missingFields.length > 0 || lowConfidenceFields.length > 0;

  if (!hasIssues) {
    return null;
  }

  return (
    <Alert variant="warning" className={cn('mb-4', className)}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t('needs_review.title')}</AlertTitle>
      <AlertDescription>
        <p className="text-sm mb-3">{t('needs_review.intro')}</p>
        <ul className="space-y-1.5">
          {missingFields.map((field) => (
            <li key={field.key} className="flex items-center gap-2 text-sm">
              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
              <span>{t('needs_review.missing', { label: t(`lease_review.field_labels.${field.key}`, { defaultValue: field.label }) })}</span>
            </li>
          ))}
          {lowConfidenceFields.map((field) => {
            // Match the per-field ConfidenceBadge: red (low) below 70%,
            // amber (medium) for 70–80%. Keeps banner + badge in one voice.
            const isLow = field.tier === 'low';
            const Icon = isLow ? XCircle : AlertTriangle;
            return (
              <li key={field.key} className="flex items-center gap-2 text-sm">
                <Icon
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    isLow ? 'text-destructive' : 'text-amber-500'
                  )}
                />
                <span>{t('needs_review.low_confidence', { label: t(`lease_review.field_labels.${field.key}`, { defaultValue: field.label }), pct: field.pct })}</span>
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
