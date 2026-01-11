import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Building2, Truck, Settings, Box, ArrowLeft, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useLifecycleWorkflow } from '@/hooks/useLifecycleWorkflow';
import { useApp } from '@/contexts/AppContext';
import type { LeaseCategory } from '@/types/lifecycle';
import { CATEGORY_LABELS } from '@/types/lifecycle';

const CATEGORY_ICONS: Record<LeaseCategory, typeof Building2> = {
  property: Building2,
  equipment: Settings,
  vehicle: Truck,
  other: Box,
};

export default function NewLease() {
  const navigate = useNavigate();
  const { workspace } = useApp();
  const { isBusinessPlan, isLoading, createDraftLease } = useLifecycleWorkflow();

  const [category, setCategory] = useState<LeaseCategory>('property');
  const [businessUnit, setBusinessUnit] = useState('');
  const [estimatedTermMin, setEstimatedTermMin] = useState('');
  const [estimatedTermMax, setEstimatedTermMax] = useState('');
  const [estimatedCostMin, setEstimatedCostMin] = useState('');
  const [estimatedCostMax, setEstimatedCostMax] = useState('');
  const [notes, setNotes] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!businessUnit.trim()) {
      return;
    }

    const termMin = parseInt(estimatedTermMin) || 12;
    const termMax = parseInt(estimatedTermMax) || termMin;

    const leaseId = await createDraftLease({
      category,
      businessUnit: businessUnit.trim(),
      estimatedTermMin: termMin,
      estimatedTermMax: termMax,
      estimatedMonthlyCostMin: estimatedCostMin ? parseFloat(estimatedCostMin) : undefined,
      estimatedMonthlyCostMax: estimatedCostMax ? parseFloat(estimatedCostMax) : undefined,
      notes: notes.trim() || undefined,
    });

    if (leaseId) {
      navigate(`/app/leases/${leaseId}`);
    }
  };

  if (!isBusinessPlan) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-6">
          <FileText className="h-16 w-16 text-muted-foreground mb-4" />
          <h2 className="text-2xl font-semibold mb-2">Business Plan Required</h2>
          <p className="text-muted-foreground text-center max-w-md mb-6">
            The lease lifecycle workflow is available exclusively on the Business plan. 
            Upgrade to start managing leases from intent to activation.
          </p>
          <Button onClick={() => navigate('/app/upgrade')}>
            Upgrade to Business
          </Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title="New Lease"
        subtitle="Capture lease intent early"
        actions={
          <Button variant="outline" onClick={() => navigate('/app/dashboard')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        }
      />

      <div className="p-6 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Category Selection */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lease Category</CardTitle>
              <CardDescription>What type of asset are you leasing?</CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={category}
                onValueChange={(v) => setCategory(v as LeaseCategory)}
                className="grid grid-cols-2 gap-4"
              >
                {(Object.keys(CATEGORY_LABELS) as LeaseCategory[]).map((cat) => {
                  const Icon = CATEGORY_ICONS[cat];
                  return (
                    <div key={cat}>
                      <RadioGroupItem
                        value={cat}
                        id={cat}
                        className="peer sr-only"
                      />
                      <Label
                        htmlFor={cat}
                        className="flex flex-col items-center justify-center p-4 border-2 rounded-lg cursor-pointer transition-all peer-checked:border-primary peer-checked:bg-primary/5 hover:bg-muted/50"
                      >
                        <Icon className="h-8 w-8 mb-2 text-muted-foreground peer-checked:text-primary" />
                        <span className="font-medium">{CATEGORY_LABELS[cat]}</span>
                      </Label>
                    </div>
                  );
                })}
              </RadioGroup>
            </CardContent>
          </Card>

          {/* Business Unit */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Business Unit / Location</CardTitle>
              <CardDescription>Which team or location will use this lease?</CardDescription>
            </CardHeader>
            <CardContent>
              <Input
                placeholder="e.g., New York Office, Fleet Operations, IT Department"
                value={businessUnit}
                onChange={(e) => setBusinessUnit(e.target.value)}
                required
              />
            </CardContent>
          </Card>

          {/* Estimated Term */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Estimated Lease Term</CardTitle>
              <CardDescription>How long do you expect this lease to run? (in months)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="termMin" className="text-xs text-muted-foreground">Minimum</Label>
                  <Input
                    id="termMin"
                    type="number"
                    min="1"
                    placeholder="12"
                    value={estimatedTermMin}
                    onChange={(e) => setEstimatedTermMin(e.target.value)}
                    required
                  />
                </div>
                <span className="text-muted-foreground mt-5">to</span>
                <div className="flex-1">
                  <Label htmlFor="termMax" className="text-xs text-muted-foreground">Maximum</Label>
                  <Input
                    id="termMax"
                    type="number"
                    min="1"
                    placeholder="36"
                    value={estimatedTermMax}
                    onChange={(e) => setEstimatedTermMax(e.target.value)}
                  />
                </div>
                <span className="text-muted-foreground mt-5">months</span>
              </div>
            </CardContent>
          </Card>

          {/* Estimated Cost */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Estimated Monthly Cost</CardTitle>
              <CardDescription>Optional: What's the expected monthly payment range?</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="costMin" className="text-xs text-muted-foreground">Minimum</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                    <Input
                      id="costMin"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="1,000"
                      className="pl-7"
                      value={estimatedCostMin}
                      onChange={(e) => setEstimatedCostMin(e.target.value)}
                    />
                  </div>
                </div>
                <span className="text-muted-foreground mt-5">to</span>
                <div className="flex-1">
                  <Label htmlFor="costMax" className="text-xs text-muted-foreground">Maximum</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                    <Input
                      id="costMax"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="5,000"
                      className="pl-7"
                      value={estimatedCostMax}
                      onChange={(e) => setEstimatedCostMax(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Notes</CardTitle>
              <CardDescription>Optional: Any additional context or requirements</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Add any relevant notes, links to proposals, or special requirements..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
              />
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate('/app/dashboard')}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !businessUnit.trim()}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Save Draft'
              )}
            </Button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
