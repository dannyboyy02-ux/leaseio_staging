import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, AlertTriangle, TrendingUp, Calendar, DollarSign,
  Building2, ChevronRight, Info,
} from 'lucide-react';
import { format } from 'date-fns';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { calculateLease } from '@/lib/leaseCalculations';

// ------------------------------------------------------------------ types
interface LeaseFull {
  id: string;
  tenant_name: string | null;
  request_title: string | null;
  requesting_department: string | null;
  lease_start: string | null;
  lease_end: string | null;
  term_months: number | null;
  monthly_payment: number | null;
  current_monthly_rent: number | null;
  executed_monthly_payment: number | null;
  escalation_type: string | null;
  escalation_rate: number | null;
  needs_escalation_review: boolean | null;
  lifecycle_status: string;
  discount_rate: number | null;
  notes: string | null;
  created_at: string;
}

// ------------------------------------------------------------------ helpers
const STATUS_STYLES: Record<string, string> = {
  submitted:    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  under_review: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  approved:     'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  rejected:     'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  executed:     'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  active:       'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  expired:      'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  cancelled:    'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const STATUS_LABELS: Record<string, string> = {
  submitted:    'Awaiting Manager Review',
  under_review: 'Awaiting Financial Review',
  approved:     'Approved',
  rejected:     'Rejected',
  executed:     'Executed',
  active:       'Active',
  expired:      'Expired',
  cancelled:    'Cancelled',
};

const fmt$ = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function deriveTermMonths(leaseStart: string | null, leaseEnd: string | null): number | null {
  if (!leaseStart || !leaseEnd) return null;
  return Math.max(
    1,
    Math.round(
      (new Date(leaseEnd).getTime() - new Date(leaseStart).getTime()) /
        ((365.25 / 12) * 24 * 60 * 60 * 1000)
    )
  );
}

// ------------------------------------------------------------------ component
export default function LeaseDetail() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const { workspace } = useApp();
  const navigate = useNavigate();

  // Fetch lease
  const { data: lease, isLoading: leaseLoading } = useQuery({
    queryKey: ['lease-detail', leaseId],
    enabled: !!leaseId,
    queryFn: async (): Promise<LeaseFull> => {
      const { data, error } = await supabase
        .from('leases')
        .select(
          'id, tenant_name, request_title, requesting_department, lease_start, lease_end,' +
          'term_months, monthly_payment, current_monthly_rent, executed_monthly_payment,' +
          'escalation_type, escalation_rate, needs_escalation_review, lifecycle_status,' +
          'discount_rate, notes, created_at'
        )
        .eq('id', leaseId!)
        .single();
      if (error) throw error;
      return data as LeaseFull;
    },
  });

  // Fetch workspace IBR (discount_rate)
  const { data: wsSettings } = useQuery({
    queryKey: ['workspace-ibr', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from('workspaces')
        .select('discount_rate')
        .eq('id', workspace!.id)
        .single();
      return data as { discount_rate: number | null } | null;
    },
  });

  // Compute financial metrics — pure, no side effects
  const metrics = useMemo(() => {
    if (!lease) return null;

    const monthlyPayment =
      Number(lease.monthly_payment) ||
      Number(lease.current_monthly_rent) ||
      Number(lease.executed_monthly_payment) ||
      0;

    if (!monthlyPayment) {
      console.warn('[LeaseDetail] Cannot compute metrics: no monthly payment');
      return null;
    }

    const termMonths =
      lease.term_months ?? deriveTermMonths(lease.lease_start, lease.lease_end);

    if (!termMonths) {
      console.warn('[LeaseDetail] Cannot compute metrics: term_months unavailable');
      return null;
    }

    const startDate = lease.lease_start ?? new Date().toISOString().slice(0, 10);
    const escalationRate = Number(lease.escalation_rate) || 0;
    const discountRate = Number(wsSettings?.discount_rate) || Number(lease.discount_rate) || 5.5;

    try {
      return {
        ...calculateLease({ monthlyPayment, termMonths, startDate, escalationRate, discountRate }),
        discountRate,
        monthlyPayment,
        termMonths,
      };
    } catch (err) {
      console.warn('[LeaseDetail] calculateLease error:', err);
      return null;
    }
  }, [lease, wsSettings]);

  // ---------------------------------------------------------------- loading
  if (leaseLoading) {
    return (
      <AppLayout>
        <AppHeader title="Lease Detail" />
        <div className="p-6 max-w-4xl space-y-4">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!lease) {
    return (
      <AppLayout>
        <AppHeader title="Lease not found" />
        <div className="p-6">
          <p className="text-muted-foreground">This lease could not be loaded.</p>
          <Button className="mt-4" onClick={() => navigate(-1)}>Go back</Button>
        </div>
      </AppLayout>
    );
  }

  const statusStyle = STATUS_STYLES[lease.lifecycle_status] ?? 'bg-gray-100 text-gray-600';
  const statusLabel = STATUS_LABELS[lease.lifecycle_status] ?? lease.lifecycle_status;

  return (
    <AppLayout>
      <AppHeader
        title={lease.tenant_name || lease.request_title || 'Lease Detail'}
        subtitle={lease.request_title || ''}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Back
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/app/approvals`)}
            >
              Approval Queue
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        }
      />

      <div className="p-6 max-w-4xl space-y-4">

        {/* Status banner */}
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${statusStyle}`}>
            {statusLabel}
          </span>
          <span className="text-xs text-muted-foreground">
            Submitted {format(new Date(lease.created_at), 'MMM d, yyyy')}
          </span>
        </div>

        {/* Escalation review warning */}
        {lease.needs_escalation_review && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                Escalation Review Required
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                This lease uses CPI / index-based escalation. The escalation rate must be
                confirmed before the rent schedule can be finalized.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Lease details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                <Building2 className="h-4 w-4" />
                Lease Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Row label="Requesting Dept" value={lease.requesting_department} />
              <Row
                label="Start Date"
                value={
                  lease.lease_start
                    ? format(new Date(lease.lease_start), 'MMM d, yyyy')
                    : null
                }
              />
              <Row
                label="End Date"
                value={
                  lease.lease_end
                    ? format(new Date(lease.lease_end), 'MMM d, yyyy')
                    : null
                }
              />
              <Row
                label="Term"
                value={
                  metrics?.termMonths
                    ? `${metrics.termMonths} months`
                    : lease.term_months
                    ? `${lease.term_months} months`
                    : null
                }
              />
              <Row
                label="Monthly Rent"
                value={
                  metrics?.monthlyPayment
                    ? fmt$(metrics.monthlyPayment)
                    : null
                }
              />
              <Row
                label="Escalation Type"
                value={
                  lease.escalation_type
                    ? lease.escalation_type === 'index'
                      ? 'CPI / Index'
                      : lease.escalation_type === 'percent'
                      ? 'Fixed %'
                      : lease.escalation_type
                    : 'None'
                }
              />
              {(lease.escalation_type === 'percent' || lease.escalation_rate) && (
                <Row
                  label="Escalation Rate"
                  value={
                    lease.escalation_rate != null
                      ? `${Number(lease.escalation_rate).toFixed(2)}% / yr`
                      : null
                  }
                />
              )}
              {lease.notes && (
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{lease.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Financial metrics */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                <TrendingUp className="h-4 w-4" />
                Financial Metrics
              </CardTitle>
            </CardHeader>
            <CardContent>
              {metrics ? (
                <div className="space-y-4">
                  <Metric
                    label="PV Liability (ASC 842)"
                    value={fmt$(metrics.pvLiability)}
                    sub={`at ${metrics.discountRate.toFixed(2)}% IBR`}
                  />
                  <Metric
                    label="Total Contracted Obligation"
                    value={fmt$(metrics.totalCashCommitment)}
                    sub="sum of all scheduled payments"
                  />
                  <Metric
                    label="Normalized Monthly Cost"
                    value={`${fmt$(metrics.straightLineExpense)} / mo`}
                    sub="straight-line (ASC 842 operating)"
                  />
                  <Metric
                    label="Cash vs. P&L at Midpoint"
                    value={`${metrics.cashPLDelta >= 0 ? '+' : ''}${fmt$(metrics.cashPLDelta)}`}
                    sub={metrics.cashPLDelta >= 0 ? 'cash ahead of P&L' : 'P&L ahead of cash'}
                    highlight={Math.abs(metrics.cashPLDelta) > metrics.totalCashCommitment * 0.05}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Info className="h-8 w-8 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">Metrics unavailable</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-[200px]">
                    Monthly rent and term dates are required to compute financial projections.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}

// ------------------------------------------------------------------ sub-components
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm font-medium text-right">{value ?? <span className="text-muted-foreground">—</span>}</span>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className={`p-3 rounded-lg ${highlight ? 'bg-amber-50 dark:bg-amber-950/20' : 'bg-muted/40'}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold font-display mt-0.5 ${highlight ? 'text-amber-700 dark:text-amber-400' : ''}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
