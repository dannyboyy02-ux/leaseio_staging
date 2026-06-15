// @vitest-environment jsdom
import '../../workspace/__tests__/_jsdomPolyfills';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

// Coverage for the 2026-06 "Adjust plan" picker (src/components/billing/
// PlanPickerDialog.tsx). The picker is purely presentational — it owns no
// checkout logic — so the contract worth pinning is the RENDERED choice set:
//   1. It iterates PLAN_ORDER, which deliberately EXCLUDES Vault (Vault is an
//      offramp, never a pricing surface — a regression that put it back on a
//      plan-selection screen would be a strategy violation).
//   2. The current plan's row is disabled with the "Current plan" label.
//   3. A move to a higher tier reads as an upgrade; a move to a lower tier
//      reads as a switch/downgrade (different CTA + button variant).

// --- Mocks ----------------------------------------------------------------

// Echo the i18n key (+ interpolated params) so assertions can match on keys
// rather than translated copy.
vi.mock('@/hooks/useAppTranslation', () => ({
  useAppTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        const params = Object.entries(opts)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',');
        return params ? `${key}(${params})` : key;
      }
      return key;
    },
  }),
}));

import { PlanPickerDialog } from '../PlanPickerDialog';
import { PLAN_ORDER, PLANS, isUpgrade } from '@/config/pricing';
import type { SubscriptionPlan } from '@/config/pricing';

afterEach(cleanup);

function renderPicker(overrides: Partial<React.ComponentProps<typeof PlanPickerDialog>> = {}) {
  const props: React.ComponentProps<typeof PlanPickerDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    currentPlan: 'starter',
    billingInterval: 'monthly',
    onBillingIntervalChange: vi.fn(),
    onSelectPlan: vi.fn(),
    isBusy: null,
    ...overrides,
  };
  render(<PlanPickerDialog {...props} />);
  return props;
}

describe('PlanPickerDialog — plan set', () => {
  it('renders exactly the PLAN_ORDER plans (Starter + Business) and never Vault', () => {
    renderPicker();
    for (const planId of PLAN_ORDER) {
      expect(screen.getByText(PLANS[planId].nameKey)).toBeTruthy();
    }
    // Vault is excluded from PLAN_ORDER and must never appear here.
    expect(PLAN_ORDER).not.toContain('vault');
    expect(screen.queryByText(PLANS.vault.nameKey)).toBeNull();
  });
});

describe('PlanPickerDialog — current plan', () => {
  it('disables the current plan with the "Current plan" label and no select handler', () => {
    const { onSelectPlan } = renderPicker({ currentPlan: 'starter' });
    const currentBtn = screen.getByText('account.adjust_plan_current').closest('button');
    expect(currentBtn).toBeTruthy();
    expect((currentBtn as HTMLButtonElement).disabled).toBe(true);
    currentBtn!.click();
    expect(onSelectPlan).not.toHaveBeenCalled();
  });
});

describe('PlanPickerDialog — upgrade vs downgrade labels', () => {
  // Find the action button inside a plan's card by its visible plan name.
  function actionButtonFor(planId: SubscriptionPlan): HTMLButtonElement {
    const card = screen.getByText(PLANS[planId].nameKey).closest('div[class*="rounded-lg"]');
    expect(card, `card for ${planId}`).toBeTruthy();
    return within(card as HTMLElement).getByRole('button') as HTMLButtonElement;
  }

  it('shows the upgrade CTA for a higher tier (Starter -> Business)', () => {
    expect(isUpgrade('starter', 'business')).toBe(true);
    renderPicker({ currentPlan: 'starter' });
    const btn = actionButtonFor('business');
    // Parameterized label "Upgrade to {{plan}}" — not a hardcoded plan name.
    expect(btn.textContent).toContain('account.upgrade_to_plan');
    expect(btn.disabled).toBe(false);
  });

  it('shows the switch/downgrade CTA for a lower tier (Business -> Starter)', () => {
    expect(isUpgrade('business', 'starter')).toBe(false);
    renderPicker({ currentPlan: 'business' });
    const btn = actionButtonFor('starter');
    expect(btn.textContent).toContain('account.adjust_plan_switch_starter');
    expect(btn.textContent).not.toContain('account.upgrade_card_cta');
  });

  it('selecting a plan delegates the planId to the parent handler', () => {
    const { onSelectPlan } = renderPicker({ currentPlan: 'starter' });
    actionButtonFor('business').click();
    expect(onSelectPlan).toHaveBeenCalledWith('business');
  });

  it('a busy planId disables every action button (no double-submit)', () => {
    renderPicker({ currentPlan: 'starter', isBusy: 'business' });
    expect(actionButtonFor('business').disabled).toBe(true);
  });
});
