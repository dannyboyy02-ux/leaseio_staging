import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P0-h (Decision 1, owner-ratified): the default Starter signup path used to
// never touch Stripe — no checkout, no trial clock, no server gate → the product
// was free forever. Fix: onboarding routes BOTH plans through checkout with a
// 7-day trial (card up front), and the paid-AI entry points refuse to process
// documents for a workspace that never started a subscription (grandfathering
// pre-cutoff workspaces; exempting the free 'audit' lead-magnet and 'vault').
//
// The gate lives in a SHARED helper (_shared/monetization.ts) so process_lease
// (first pass) AND retry_lease (retry) stay in lockstep — a retry hits Claude
// exactly like a first pass, so omitting it there was a free-extraction bypass
// (security review 2026-07-16, HIGH-2).

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P0-h — onboarding routes both plans through checkout', () => {
  const onb = read('src/pages/app/Onboarding.tsx');
  it('Starter no longer navigates straight to /app/leases (free)', () => {
    // Both plans now go to billing with autoCheckout + the plan param.
    expect(onb).toContain('autoCheckout=1&plan=${selectedPlan}');
    expect(onb).not.toMatch(/selectedPlan === 'business'\s*\n?\s*\?[\s\S]{0,80}:\s*'\/app\/leases'/);
  });
  it('the step-3 CTA routes to checkout for both plans (no false "upload" promise)', () => {
    // Starter used to show "upload your first lease" here — impossible before the
    // subscription gate. It must now show continue_to_checkout like Business.
    expect(onb).toContain("t('onboarding_flow.continue_to_checkout')");
  });
  it('autoCheckout fires for the chosen plan (not hardcoded business)', () => {
    const acc = read('src/pages/settings/AccountSettings.tsx');
    expect(acc).toContain("searchParams.get('plan')");
    expect(acc).toContain('proceedWithCheckout(checkoutPlan)');
  });
});

describe('P0-h — shared monetization gate', () => {
  const helper = read('supabase/functions/_shared/monetization.ts');
  it('defines the shared never-subscribed predicate + exemptions + grandfather', () => {
    expect(helper).toContain('export function requiresSubscriptionToProcess');
    // Exempts audit + vault.
    expect(helper).toMatch(/plan === 'audit' \|\| ws\.plan === 'vault'/);
    // Never-subscribed = no status AND no stripe subscription id.
    expect(helper).toMatch(/!ws\.subscription_status\s*&&\s*!ws\.stripe_subscription_id/);
    // Grandfather cutoff.
    expect(helper).toContain('MONETIZATION_ENFORCED_FROM');
    expect(helper).toMatch(/createdAt >= MONETIZATION_ENFORCED_FROM/);
  });
});

describe('P0-h — both paid-AI entry points call the shared gate', () => {
  it('process_lease (first pass) gates never-subscribed workspaces', () => {
    const pl = read('supabase/functions/process_lease/index.ts');
    expect(pl).toContain('from "../_shared/monetization.ts"');
    expect(pl).toContain('requiresSubscriptionToProcess(wsRow)');
    expect(pl).toContain('reason: NO_SUBSCRIPTION_REASON');
  });
  it('retry_lease (retry) gates never-subscribed workspaces (HIGH-2 fix)', () => {
    const rl = read('supabase/functions/retry_lease/index.ts');
    expect(rl).toContain('from "../_shared/monetization.ts"');
    expect(rl).toContain('requiresSubscriptionToProcess(wsLiveRow)');
    // The liveness SELECT must actually load the columns the gate reads.
    expect(rl).toMatch(/subscription_status, stripe_subscription_id, created_at/);
  });
});

describe('P0-h — created_at is immutable (HIGH-1 grandfather-bypass fix)', () => {
  it('a non-service writer cannot rewrite workspaces.created_at', () => {
    const mig = read('supabase/migrations/20260716160000_workspaces_created_at_immutable.sql');
    expect(mig).toContain('prevent_workspaces_created_at_edit');
    expect(mig).toMatch(/NEW\.created_at IS DISTINCT FROM OLD\.created_at/);
    expect(mig).toContain('created_at is immutable');
    // Trigger is actually wired.
    expect(mig).toMatch(/CREATE TRIGGER trg_prevent_workspaces_created_at_edit[\s\S]{0,120}BEFORE UPDATE ON public\.workspaces/);
  });
});
