import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { useAppTranslation } from '@/hooks/useAppTranslation';

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const [workspaceName, setWorkspaceName] = useState('');
  // Match Signup default: 'starter' is the canonical entry-tier in
  // src/config/pricing.ts (SubscriptionPlan = 'starter' | 'business').
  // 'free' was off-spec and would fail TS narrowing; normalizePlanId
  // would coerce it back to 'starter' anyway.
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan>('starter');
  const [isLoading, setIsLoading] = useState(false);
  const { user } = useAuth();
  const { refreshProfile, workspace, isLoading: appLoading } = useApp();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, language } = useAppTranslation();

  useEffect(() => {
    if (!appLoading && workspace) {
      navigate('/app/dashboard', { replace: true });
    }
  }, [workspace, appLoading, navigate]);

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
      const workspacePlan: SubscriptionPlan = selectedPlan;
      const planConfig = PLANS[workspacePlan];
      
      // Create workspace
      const { data: workspace, error: workspaceError } = await supabase
        .from('workspaces')
        .insert({
          name: workspaceName.trim(),
          owner_id: user.id,
          plan: workspacePlan,
          document_limit: planConfig.maxActiveLeases,
        })
        .select()
        .single();

      if (workspaceError) throw workspaceError;

      // Add owner as admin (owner is tracked via workspaces.owner_id)
      const { error: memberError } = await supabase
        .from('workspace_members')
        .insert({
          workspace_id: workspace.id,
          user_id: user.id,
          role: 'admin',
        });

      if (memberError) throw memberError;

      const { error: profileError } = await supabase
        .from('profiles')
        .update({ current_workspace_id: workspace.id } as any)
        .eq('id', user.id);

      if (profileError) throw profileError;

      toast({
        title: t('onboarding_flow.workspace_created_title'),
        description: t('onboarding_flow.workspace_created_desc'),
      });

      await refreshProfile();
      navigate(selectedPlan === 'business' ? '/app/settings/account?tab=subscription' : '/app/leases');
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
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
            <FileText className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-display font-bold text-2xl text-foreground">
            Lease<span className="text-primary">IO</span>
          </span>
        </div>

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
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
                  {t('onboarding_flow.all_set_desc', {
                    name: workspaceName,
                    plan: t(selectedPlanConfig.nameKey),
                  })}
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="bg-muted/50 rounded-lg p-4 space-y-2">
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
                  {selectedPlanConfig.price.monthly > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{t('onboarding_flow.trial_ends')}</span>
                      <span className="font-medium text-foreground">
                        {new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString(
                          language === 'es' ? 'es-419' : 'en-US'
                        )}
                      </span>
                    </div>
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
                      t('onboarding_flow.upload_first_lease')
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
