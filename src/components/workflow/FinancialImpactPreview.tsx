import { AlertTriangle, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { LeaseCalculations } from '@/lib/leaseCalculations';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';

interface FinancialImpactPreviewProps {
  calculations: LeaseCalculations;
  covenantFlagged: boolean;
  covenantThreshold?: number | null;
  discountRate: number;
  termMonths: number;
}

export function FinancialImpactPreview({
  calculations,
  covenantFlagged,
  covenantThreshold,
  discountRate,
  termMonths,
}: FinancialImpactPreviewProps) {
  const { language } = useLanguage();
  const fmt = (amount: number) => formatLocalizedCurrency(amount, language);
  const exceedsThreshold =
    covenantThreshold != null &&
    covenantThreshold > 0 &&
    calculations.pvLiability > covenantThreshold;

  const metrics = [
    {
      label: 'Total Cash Commitment',
      value: fmt(calculations.totalCashCommitment),
      note: `Over ${termMonths} months`,
    },
    {
      label: 'Estimated Lease Liability',
      value: fmt(calculations.pvLiability),
      note: `PV at ${discountRate}% discount rate`,
    },
    {
      label: 'Monthly P&L Charge',
      value: fmt(calculations.straightLineExpense),
      note: 'Straight-line per month',
    },
    {
      label: 'Cash vs. P&L Delta',
      value: fmt(Math.abs(calculations.cashPLDelta)),
      note: `At lease midpoint · ${
        calculations.cashPLDelta >= 0 ? 'cash ahead of P&L' : 'P&L ahead of cash'
      }`,
    },
  ];

  return (
    <Card className="bg-muted/40 border-dashed">
      <CardContent className="pt-4 pb-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Financial Impact Preview
        </p>

        {covenantFlagged && (
          <div className="flex items-start gap-2 rounded-md bg-warning/10 border border-warning/30 px-3 py-2 text-sm text-warning">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Flagged for covenant review — Financial Approver will be notified</span>
          </div>
        )}

        {exceedsThreshold && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Estimated liability exceeds covenant threshold</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          {metrics.map((m) => (
            <div key={m.label} className="space-y-0.5">
              <p className="text-xs text-muted-foreground">{m.label}</p>
              <p className="text-xl font-bold font-display">{m.value}</p>
              <p className="text-[11px] text-muted-foreground">{m.note}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
