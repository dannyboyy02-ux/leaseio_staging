// Workspace discount-rate (incremental borrowing rate) card.
//
// Moved out of the dissolved Workspace Settings → Financial tab in the
// 2026-06 Claude-alignment pass. The rate drives PV-liability and
// straight-line calculations shown on the Dashboard, Portfolio, and
// disclosure reports — so it lives on /app/reports next to the other
// report settings, where the numbers it shapes are consumed.
//
// Saving re-derives the stored calc_* columns for every lease in the
// workspace (same recompute the Financial tab performed) so reported
// figures never lag the configured rate.

import { useEffect, useState } from 'react';
import { Loader2, Save, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { calculateLease } from '@/lib/leaseCalculations';
import { useLanguage } from '@/contexts/LanguageContext';

async function recomputeWorkspaceLeaseFinancials(workspaceId: string, discountRate: number) {
  const { data: leases, error } = await supabase
    .from('leases')
    .select(
      'id, executed_monthly_payment, current_monthly_rent, monthly_payment, lease_start, term_months, escalation_rate'
    )
    .eq('workspace_id', workspaceId);

  if (error) throw error;

  const updates = (leases || []).map((lease) => {
    const monthlyPayment =
      Number((lease as any).executed_monthly_payment) ||
      Number((lease as any).current_monthly_rent) ||
      Number((lease as any).monthly_payment) ||
      0;

    const termMonths = Number((lease as any).term_months) || 0;
    const startDate = (lease as any).lease_start;
    const escalationRate = Number((lease as any).escalation_rate) || 0;

    if (!monthlyPayment || !termMonths || !startDate) {
      return supabase
        .from('leases')
        .update({
          calc_total_commitment: null,
          calc_pv_liability: null,
          calc_straight_line_exp: null,
          calc_cash_pl_delta: null,
        } as any)
        .eq('id', lease.id);
    }

    const calcs = calculateLease({
      monthlyPayment,
      termMonths,
      startDate,
      escalationRate,
      discountRate,
    });

    return supabase
      .from('leases')
      .update({
        calc_total_commitment: calcs.totalCashCommitment,
        calc_pv_liability: calcs.pvLiability,
        calc_straight_line_exp: calcs.straightLineExpense,
        calc_cash_pl_delta: calcs.cashPLDelta,
      } as any)
      .eq('id', lease.id);
  });

  await Promise.all(updates);
}

interface Props {
  workspaceId: string;
  canEdit: boolean;
}

export function DiscountRateCard({ workspaceId, canEdit }: Props) {
  const { t } = useLanguage();
  const [discountRate, setDiscountRate] = useState('5.5');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('workspaces')
        .select('discount_rate')
        .eq('id', workspaceId)
        .maybeSingle();
      if (cancelled) return;
      setDiscountRate(String((data as any)?.discount_rate ?? 5.5));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const handleSave = async () => {
    // Handler-level gate, not just the disabled button — every other
    // settings save handler guards this way (security review 2026-06-12:
    // the leases-recompute below is editor-writable under RLS, so the
    // button state alone must never be the only gate).
    if (!canEdit) {
      toast.error(t('reports.discount_rate_readonly'));
      return;
    }
    const parsed = parseFloat(discountRate);
    if (!(parsed > 0 && parsed <= 50)) {
      toast.error(t('reports.discount_rate_invalid'));
      return;
    }
    setSaving(true);
    try {
      // #70 defense-in-depth: confirm the rate actually persisted (.select +
      // 0-row check) BEFORE recomputing every lease's financials — otherwise
      // an RLS-blocked no-op would rewrite calc_* from an unsaved rate.
      const { data, error } = await supabase
        .from('workspaces')
        .update({ discount_rate: parsed } as any)
        .eq('id', workspaceId)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('not_saved');
      await recomputeWorkspaceLeaseFinancials(workspaceId, parsed);
      toast.success(t('reports.discount_rate_saved'));
    } catch (error) {
      console.error('Error saving discount rate:', error);
      toast.error(t('reports.discount_rate_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle>{t('reports.discount_rate_title')}</CardTitle>
            <CardDescription>{t('reports.discount_rate_desc')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="discount-rate">{t('reports.discount_rate_label')}</Label>
              <div className="relative max-w-xs">
                <Input
                  id="discount-rate"
                  type="number"
                  min={0}
                  step="0.1"
                  value={discountRate}
                  onChange={(e) => setDiscountRate(e.target.value)}
                  disabled={!canEdit}
                  className="pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
              </div>
              <p className="text-xs text-muted-foreground">{t('reports.discount_rate_help')}</p>
            </div>
            <Button variant="accent" onClick={handleSave} disabled={!canEdit || saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {saving ? t('reports.discount_rate_saving') : t('reports.discount_rate_save')}
            </Button>
            {!canEdit && (
              <p className="text-xs text-muted-foreground">{t('reports.discount_rate_readonly')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
