import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { FileText, Loader2, Check, Building2, CreditCard, Upload } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

const plans = [
  {
    id: 'pro',
    name: 'Pro',
    price: '$49/mo',
    documents: '3 documents',
    features: ['AI lease abstraction', 'Email & SMS notifications', 'Renewal tracking'],
  },
  {
    id: 'business',
    name: 'Business',
    price: '$149/mo',
    documents: '20 documents',
    features: ['Everything in Pro', 'CSV/Excel export', 'QuickBooks integration', 'Advanced reporting'],
    popular: true,
  },
];

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const [workspaceName, setWorkspaceName] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('pro');
  const [isLoading, setIsLoading] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    // Pre-fill workspace name from user metadata if available
    if (user?.user_metadata?.company_name) {
      setWorkspaceName(user.user_metadata.company_name);
    }
  }, [user]);

  const handleCreateWorkspace = async () => {
    if (!workspaceName.trim()) {
      toast({
        title: 'Workspace name required',
        description: 'Please enter a name for your workspace.',
        variant: 'destructive',
      });
      return;
    }

    if (!user) {
      toast({
        title: 'Not authenticated',
        description: 'Please sign in to continue.',
        variant: 'destructive',
      });
      navigate('/login');
      return;
    }

    setIsLoading(true);

    try {
      // Create workspace
      const { data: workspace, error: workspaceError } = await supabase
        .from('workspaces')
        .insert({
          name: workspaceName.trim(),
          owner_id: user.id,
          plan: selectedPlan,
          document_limit: selectedPlan === 'business' ? 20 : 3,
        })
        .select()
        .single();

      if (workspaceError) throw workspaceError;

      // Add owner as a member
      const { error: memberError } = await supabase
        .from('workspace_members')
        .insert({
          workspace_id: workspace.id,
          user_id: user.id,
          role: 'owner',
        });

      if (memberError) throw memberError;

      toast({
        title: 'Workspace created!',
        description: 'Your workspace is ready. Let\'s upload your first lease.',
      });

      navigate('/app/leases');
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to create workspace.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
            <FileText className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-display font-bold text-2xl text-foreground">
            LeaseAbstract<span className="text-primary">Pro</span>
          </span>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center justify-center gap-4 mb-8">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center">
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  s < step
                    ? 'bg-accent text-accent-foreground'
                    : s === step
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {s < step ? <Check className="h-4 w-4" /> : s}
              </div>
              {s < 3 && <div className={`w-12 h-0.5 ${s < step ? 'bg-accent' : 'bg-muted'}`} />}
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
                <h1 className="font-display text-2xl font-bold text-foreground">Name your workspace</h1>
                <p className="text-muted-foreground">
                  This is where you'll manage all your leases.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="workspaceName">Workspace name</Label>
                  <Input
                    id="workspaceName"
                    placeholder="Acme Properties"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                  />
                </div>
                <Button onClick={() => setStep(2)} className="w-full" disabled={!workspaceName.trim()}>
                  Continue
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
                <h1 className="font-display text-2xl font-bold text-foreground">Choose your plan</h1>
                <p className="text-muted-foreground">
                  Start with a 14-day free trial. Cancel anytime.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid sm:grid-cols-2 gap-4">
                  {plans.map((plan) => (
                    <button
                      key={plan.id}
                      onClick={() => setSelectedPlan(plan.id)}
                      className={`relative text-left p-4 rounded-xl border-2 transition-all ${
                        selectedPlan === plan.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      {plan.popular && (
                        <div className="absolute -top-2 left-4 px-2 py-0.5 rounded-full bg-accent text-accent-foreground text-xs font-medium">
                          Popular
                        </div>
                      )}
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold text-foreground">{plan.name}</span>
                        <span className="text-sm text-muted-foreground">{plan.price}</span>
                      </div>
                      <div className="text-sm text-primary font-medium mb-3">{plan.documents}</div>
                      <ul className="space-y-1">
                        {plan.features.map((feature) => (
                          <li key={feature} className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Check className="h-3 w-3 text-accent" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                    </button>
                  ))}
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep(1)} className="flex-1">
                    Back
                  </Button>
                  <Button onClick={() => setStep(3)} className="flex-1">
                    Continue
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
                <h1 className="font-display text-2xl font-bold text-foreground">You're all set!</h1>
                <p className="text-muted-foreground">
                  Your workspace "{workspaceName}" is ready with the {selectedPlan === 'business' ? 'Business' : 'Pro'} plan.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Document limit</span>
                    <span className="font-medium text-foreground">
                      {selectedPlan === 'business' ? '20' : '3'} documents
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Trial ends</span>
                    <span className="font-medium text-foreground">
                      {new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep(2)} className="flex-1">
                    Back
                  </Button>
                  <Button onClick={handleCreateWorkspace} className="flex-1" disabled={isLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      'Upload your first lease'
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
