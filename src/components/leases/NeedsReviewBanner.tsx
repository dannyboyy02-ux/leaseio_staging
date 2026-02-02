import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import type { ConfidenceScores } from '@/types/workflow';

interface NeedsReviewBannerProps {
  landlordName: string | null;
  tenantName: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  confidenceScores?: ConfidenceScores | null;
  className?: string;
}

const TIER1_FIELDS = [
  { key: 'landlord_name', label: 'Landlord Name', dataKey: 'landlordName' },
  { key: 'tenant_name', label: 'Tenant Name', dataKey: 'tenantName' },
  { key: 'lease_start', label: 'Lease Start Date', dataKey: 'leaseStart' },
  { key: 'lease_end', label: 'Lease End Date', dataKey: 'leaseEnd' },
] as const;

const LOW_CONFIDENCE_THRESHOLD = 80;

export function NeedsReviewBanner({
  landlordName,
  tenantName,
  leaseStart,
  leaseEnd,
  confidenceScores,
  className,
}: NeedsReviewBannerProps) {
  const fieldValues: Record<string, string | null> = {
    landlordName,
    tenantName,
    leaseStart,
    leaseEnd,
  };

  // Check for missing fields
  const missingFields = TIER1_FIELDS.filter(
    (field) => !fieldValues[field.dataKey]
  );

  // Check for low-confidence fields
  const lowConfidenceFields = confidenceScores
    ? TIER1_FIELDS.filter((field) => {
        const score = confidenceScores[field.key];
        return score !== undefined && score < LOW_CONFIDENCE_THRESHOLD && fieldValues[field.dataKey];
      })
    : [];

  const hasIssues = missingFields.length > 0 || lowConfidenceFields.length > 0;

  if (!hasIssues) {
    return null;
  }

  return (
    <Alert variant="warning" className={cn('mb-4', className)}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Review Required</AlertTitle>
      <AlertDescription>
        <p className="text-sm mb-3">
          Please review the following items before posting this lease:
        </p>
        <ul className="space-y-1.5">
          {missingFields.map((field) => (
            <li key={field.key} className="flex items-center gap-2 text-sm">
              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
              <span>
                <strong>{field.label}</strong> is missing
              </span>
            </li>
          ))}
          {lowConfidenceFields.map((field) => (
            <li key={field.key} className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span>
                <strong>{field.label}</strong> has low confidence (
                {confidenceScores?.[field.key]}%) — please verify
              </span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
