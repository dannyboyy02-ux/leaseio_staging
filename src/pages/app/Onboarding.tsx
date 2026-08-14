import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useApp } from '@/contexts/AppContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { FileText, Loader2, Check, Building2, CreditCard, Upload } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { PLANS, PLAN_ORDER } from '@/config/pricing';
import type { SubscriptionPlan } from '@/types';
import { cn } from '@/lib/utils';
import { ownsAnyWorkspace } from '@/lib/workspaceOwnership';
import { useAppTranslation } from '@/hooks/useAppTranslation';

export default function Onboarding() {
  const [searchParams] = useSearchParams();
  // Plan + billing interval are propagated from the landing page
  // (PricingSection) through Signup. Both default to safe values
  // ('starter', 'monthly') when the query params are missing.
  const initialPlan: SubscriptionPlan =
    searchParams.get('plan') === 'business' ? 'business' : 'starter';
  const initialBilling: 'monthly' | 'annual' =
    searchParams.get('billing') === 'annual' ? 'annual' : 'monthly';

  const [step, setStep] = useState(1);
  const [workspaceName, setWorkspaceName] = useState('');
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan>(initialPlan);
  const [selectedBilling] = useState<'monthly' | 'annual'>(initialBilling);
  const [isLoading, setIsLoading] = useState(false);
  const { user } = useAuth();
  const { refreshProfile, availableWorkspaces, isLoading: appLoading } = useApp();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useAppTranslation();

  // #195: redirect away from onboarding only when the user already OWNS a
  // workspace — not merely when they have a current one. A member of someone
  // else's workspace (owns nothing) legitimately needs this flow to create
  // their first owned workspace; the old `workspace`-based guard bounced them
  // to the dashboard. `create_first_workspace` still enforces "at most one
  // owned workspace" server-side as the backstop.
  const ownsWorkspace = ownsAnyWorkspace(availableWorkspaces);
  // An existing member (belongs to someone else's workspace) reaching this
  // full-screen flow needs a visible way BACK into the app and a line of
  // context so it doesn't read as being logged out into re-signup (#195
  // polish review HIGH). Brand-new signups (no workspaces at all) keep the
  // clean first-run framing with no back link.
  const isExistingMember = availableWorkspaces.length > 0;
  useEffect(() => {
    if (!appLoading && ownsWorkspace) {
      navigate('/app/dashboard', { replace: true });
    }
  }, [ownsWorkspace, appLoading, navigate]);

  useEffect(() => {
    // Pre-fill workspace name from user metadata if available
    if (user?.user_metadata?.company_name) {
      setWorkspaceName(user.user_metadata.company_name);
    }
  }, [user]);

  const handleCreateWorkspace = async () => {
    if (!workspaceName.trim()) {
      toast({
        title: t('onboarding_flow.workspace_name_required_title'),
        description: t('onboarding_flow.workspace_name_required_desc'),
        variant: 'destructive',
      });
      return;
    }

    if (!user) {
      toast({
        title: t('onboarding_flow.not_authenticated_title'),
        description: t('onboarding_flow.not_authenticated_desc'),
        variant: 'destructive',
      });
      navigate('/login');
      return;
    }

    setIsLoading(true);

    try {
      // Always create the workspace at Starter defaults. The
      // entitlement-guard trigger (migration 20260522000000, restoring the
      // never-applied 20260426000003) rejects any authenticated insert that
      // diverges from those defaults, so we omit plan / document_limit and
      // let the DB defaults (starter / 15) apply.
      // Stripe checkout + the signed webhook (service role, which bypasses
      // the trigger) own the promotion to Business.
      //
      // intended_plan persists the user's declared choice so AccountSettings
      // can recover an abandoned Business checkout.
      // P0-c: the first (free) workspace is created through the advisory-locked
      // SECURITY DEFINER RPC create_first_workspace — the ONLY client path to a
      // workspace now that the direct INSERT policy is WITH CHECK (false). The
      // RPC atomically enforces "at most one owned workspace" (a per-row RLS
      // count was bulk-insert-bypassable) and seeds the owner's admin membership
      // row (#9 timestamps). owner_id is derived server-side from auth.uid().
      // Cast: create_first_workspace isn't in the generated types until the
      // migration is applied + types regenerated (repo bridges with `as any`, #66).
      const { data: newWorkspaceId, error: workspaceError } = await (supabase.rpc as any)(
        'create_first_workspace',
        { p_name: workspaceName.trim(), p_intended_plan: selectedPlan },
      );

      if (workspaceError) throw workspaceError;
      const workspaceId = newWorkspaceId as unknown as string;

      const { error: profileError } = await supabase
        .from('profiles')
        .update({ current_workspace_id: workspaceId } as any)
        .eq('id', user.id);

      if (profileError) throw profileError;

      toast({
        title: t('onboarding_flow.workspace_created_title'),
        description: t('onboarding_flow.workspace_created_desc'),
      });

      await refreshProfile();
      // P0-h (Decision 1): BOTH plans now route through checkout with a 7-day
      // trial (card up front) — Starter is no longer free-forever. The billing
      // tab auto-fires checkout for the chosen plan; process_lease blocks
      // document processing until a subscription (trial) is started.
      navigate(
        `/app/settings/account?tab=billing&billing=${selectedBilling}&autoCheckout=1&plan=${selectedPlan}`,
      );
    } catch (error: any) {
      toast({
        title: t('onboarding_flow.error_title'),
        description: error.message || t('onboarding_flow.error_create_workspace'),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const selectedPlanConfig = PLANS[selectedPlan];

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl">
        {/* #195: an existing member routed here to create their first owned
            workspace needs a visible way back into the app (the full-screen
            flow strips the app chrome). Brand-new signups don't see this. */}
        {isExistingMember && (
          <button
            type="button"
            onClick={() => navigate('/app/settings/workspaces')}
            className="mb-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('onboarding_flow.member_back_link')}
          </button>
        )}
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-3">
          <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
            <FileText className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-display font-bold text-2xl text-foreground">
            Lease<span className="text-primary">IO</span>
          </span>
        </div>
        {isExistingMember && (
          <p className="text-center text-sm text-muted-foreground mb-8">
            {t('onboarding_flow.member_context_note')}
          </p>
        )}
        {!isExistingMember && <div className="mb-5" />}

        {/* Progress Steps */}
        <div className="flex items-center justify-center gap-4 mb-8">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={cn(
                  "h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium",
                  s < step
                    ? 'bg-accent text-accent-foreground'
                    : s === step
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {s < step ? <Check className="h-4 w-4" /> : s}
              </div>
              {s < 3 && <div className={cn("w-12 h-0.5", s < step ? 'bg-accent' : 'bg-muted')} />}
            </div>
          ))}
        </div>

        <Card className="shadow-lg">
          {step === 1 && (
            <>
              <CardHeader className="text-center">
                <div className="mx-auto h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <Building2 className="h-6 w-6 text-primary" />
                </div>
                <h1 className="font-display text-2xl font-bold text-foreground">
                  {t('onboarding_flow.name_workspace_title')}
                </h1>
                <p className="text-muted-foreground">
                  {t('onboarding_flow.name_workspace_desc')}
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="workspaceName">{t('onboarding_flow.workspace_name_label')}</Label>
                  <Input
                    id="workspaceName"
                    placeholder={t('onboarding_flow.workspace_name_placeholder')}
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                  />
                </div>
                <Button onClick={() => setStep(2)} className="w-full" disabled={!workspaceName.trim()}>
                  {t('onboarding_flow.continue')}
                </Button>
                {/* Phase 10 — fork: managing multiple companies → set up a firm. */}
                <button
                  type="button"
                  onClick={() => navigate('/app/firm/onboarding')}
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('onboarding_flow.firm_fork')}
                </button>
              </CardContent>
            </>
          )}

          {step === 2 && (
            <>
              <CardHeader className="text-center">
                <div className="mx-auto h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <CreditCard className="h-6 w-6 text-primary" />
                </div>
                <h1 className="font-display text-2xl font-bold text-foreground">
                  {t('onboarding_flow.choose_plan_title')}
                </h1>
                <p className="text-muted-foreground">
                  {t('onboarding_flow.choose_plan_desc')}
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Two plans (PLAN_ORDER excludes Vault) — a 4-col grid left
                    two skinny cards stranded; 2-up stays balanced like the
                    landing pricing. */}
                <div className="grid sm:grid-cols-2 gap-4">
                  {PLAN_ORDER.map((planId) => {
                    const plan = PLANS[planId];
                    return (
                      <button
                        key={plan.id}
                        onClick={() => setSelectedPlan(planId)}
                        className={cn(
                          "relative text-left p-4 rounded-xl border-2 transition-all",
                          selectedPlan === planId
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        )}
                      >
                        {plan.popular && (
                          <div className="absolute -top-2 left-4 px-2 py-0.5 rounded-full bg-accent text-accent-foreground text-xs font-medium">
                            {t('onboarding_flow.popular')}
                          </div>
                        )}
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-semibold text-foreground">{t(plan.nameKey)}</span>
                        </div>
                        <div className="text-lg font-bold text-foreground mb-1">
                          {plan.price.monthly === 0
                            ? t('onboarding_flow.free')
                            : `$${plan.price.monthly}${t('onboarding_flow.per_month')}`}
                        </div>
                        <div className="text-sm text-primary font-medium mb-3">
                          {plan.maxActiveLeases === -1 ? 'Unlimited' : plan.maxActiveLeases} {plan.maxActiveLeases === 1 ? t('onboarding_flow.lease') : t('onboarding_flow.leases')}
                        </div>
                        <ul className="space-y-1">
                          {plan.featureKeys.slice(0, 3).map((featureKey) => (
                            <li key={featureKey} className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Check className="h-3 w-3 text-accent shrink-0" />
                              <span className="truncate">{t(featureKey)}</span>
                            </li>
                          ))}
                        </ul>
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep(1)} className="flex-1">
                    {t('common.back')}
                  </Button>
                  <Button onClick={() => setStep(3)} className="flex-1">
                    {t('onboarding_flow.continue')}
                  </Button>
                </div>
              </CardContent>
            </>
          )}

          {step === 3 && (
            <>
              <CardHeader className="text-center">
                <div className="mx-auto h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <Upload className="h-6 w-6 text-primary" />
                </div>
                <h1 className="font-display text-2xl font-bold text-foreground">
                  {t('onboarding_flow.all_set_title')}
                </h1>
                <p className="text-muted-foreground">
                  {selectedPlan === 'business'
                    ? t('onboarding_flow.all_set_desc_business', { name: workspaceName })
                    : t('onboarding_flow.all_set_desc', {
                        name: workspaceName,
                        plan: t(selectedPlanConfig.nameKey),
                      })}
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                  {selectedPlan === 'business' ? (
                    // For Business, we don't show plan/limit rows because the
                    // workspace was created at Starter defaults; Stripe webhook
                    // promotes to Business after checkout. Showing "Business / 50
                    // leases" here would be a false confirmation.
                    <div className="text-sm text-foreground space-y-1">
                      <p className="font-medium">
                        {t('onboarding_flow.activating_business_line1')}
                      </p>
                      <p className="text-muted-foreground">
                        {t('onboarding_flow.activating_business_line2')}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{t('onboarding_flow.plan_label')}</span>
                        <span className="font-medium text-foreground">{t(selectedPlanConfig.nameKey)}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{t('onboarding_flow.document_limit')}</span>
                        <span className="font-medium text-foreground">
                          {selectedPlanConfig.maxActiveLeases === -1 ? 'Unlimited' : selectedPlanConfig.maxActiveLeases}{' '}
                          {selectedPlanConfig.maxActiveLeases === 1 ? t('onboarding_flow.lease') : t('onboarding_flow.leases')}
                        </span>
                      </div>
                      <div className="pt-2 mt-1 border-t border-border/60 text-sm space-y-1">
                        <p className="font-medium text-foreground">
                          {t('onboarding_flow.starter_trial_line1', { plan: t(selectedPlanConfig.nameKey) })}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {t('onboarding_flow.starter_trial_line2')}
                        </p>
                      </div>
                    </>
                  )}
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep(2)} className="flex-1">
                    {t('common.back')}
                  </Button>
                  <Button onClick={handleCreateWorkspace} className="flex-1" disabled={isLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t('onboarding_flow.creating')}
                      </>
                    ) : (
                      // Both plans now route through checkout (7-day trial); the
                      // old Starter "upload your first lease" was a false promise
                      // — nothing could be uploaded before the subscription gate.
                      t('onboarding_flow.continue_to_checkout')
                    )}
                  </Button>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
