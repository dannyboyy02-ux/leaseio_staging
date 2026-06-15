import { Check, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import {
  ANNUAL_DISCOUNT_PERCENT,
  PLANS,
  PLAN_ORDER,
  isUpgrade,
} from '@/config/pricing';
import type { SubscriptionPlan } from '@/config/pricing';
import type { BillingInterval } from '@/types';
import { cn } from '@/lib/utils';

interface PlanPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPlan: SubscriptionPlan;
  billingInterval: BillingInterval;
  onBillingIntervalChange: (interval: BillingInterval) => void;
  /** Called with the chosen plan. The parent routes it through the existing
   *  upgrade (handleUpgrade) or downgrade (setConfirmDowngradePlan) handler. */
  onSelectPlan: (planId: SubscriptionPlan) => void;
  /** The planId currently processing (disables its button), or null. */
  isBusy?: string | null;
}

/**
 * Claude-style "Adjust plan" picker. Purely presentational: the monthly/annual
 * toggle state is owned by AccountSettings (so `?billing=` pre-arm keeps
 * working) and every action delegates to the parent's existing handlers — this
 * dialog adds no checkout/business logic of its own. Vault is intentionally
 * excluded (PLAN_ORDER omits it; it's an offramp, not a pricing choice).
 */
export function PlanPickerDialog({
  open,
  onOpenChange,
  currentPlan,
  billingInterval,
  onBillingIntervalChange,
  onSelectPlan,
  isBusy,
}: PlanPickerDialogProps) {
  const { t } = useAppTranslation();
  const annual = billingInterval === 'annual';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('account.adjust_plan_title')}</DialogTitle>
          <DialogDescription>{t('account.adjust_plan_desc')}</DialogDescription>
        </DialogHeader>

        {/* Monthly / Annual toggle — same control as the old inline upgrade card. */}
        <div className="flex items-center gap-3 text-sm">
          <span
            className={cn(
              'font-medium',
              !annual ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {t('landing.pricing.monthly')}
          </span>
          <Switch
            checked={annual}
            onCheckedChange={(v) => onBillingIntervalChange(v ? 'annual' : 'monthly')}
          />
          <span
            className={cn(
              'font-medium',
              annual ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {t('landing.pricing.annual')}
          </span>
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
            {t('landing.pricing.save')} {ANNUAL_DISCOUNT_PERCENT}%
          </span>
        </div>

        <div className="space-y-3">
          {PLAN_ORDER.map((planId) => {
            const plan = PLANS[planId];
            const isCurrent = planId === currentPlan;
            const upgrade = isUpgrade(currentPlan, planId);
            const perMonth = annual ? Math.round(plan.price.annual / 12) : plan.price.monthly;
            const busy = isBusy === planId;

            return (
              <div
                key={planId}
                className={cn(
                  'rounded-lg border p-4',
                  isCurrent ? 'border-border bg-muted/30' : 'border-border',
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold text-foreground">{t(plan.nameKey)}</span>
                  <span className="text-sm">
                    <span className="text-xl font-bold">${perMonth}</span>
                    <span className="text-muted-foreground">{t('account.per_month')}</span>
                  </span>
                </div>
                {annual && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 text-right">
                    {t('account.billed_annually', { total: plan.price.annual.toLocaleString() })}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {t('account.abstractions_included', { count: plan.abstractionsIncluded })}
                </p>

                <ul className="space-y-1.5 mt-3">
                  {plan.featureKeys.slice(0, 4).map((featureKey) => (
                    <li key={featureKey} className="flex items-start gap-2 text-xs">
                      <Check className="h-3 w-3 text-success shrink-0 mt-0.5" />
                      <span className="text-muted-foreground">{t(featureKey)}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-4">
                  {isCurrent ? (
                    <Button variant="outline" size="sm" className="w-full" disabled>
                      {t('account.adjust_plan_current')}
                    </Button>
                  ) : (
                    <Button
                      variant={upgrade ? 'accent' : 'outline'}
                      size="sm"
                      className="w-full"
                      onClick={() => onSelectPlan(planId)}
                      disabled={Boolean(isBusy)}
                    >
                      {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {upgrade
                        ? t('account.upgrade_to_plan', { plan: t(plan.nameKey) })
                        : t('account.adjust_plan_switch_starter')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
