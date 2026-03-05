import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Building2, Truck, Settings, Box,
  ArrowLeft, Loader2, FilePlus, FileEdit, Cpu,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ParentLeaseCombobox } from '@/components/workflow/ParentLeaseCombobox';
import { useLifecycleWorkflow } from '@/hooks/useLifecycleWorkflow';
import { cn } from '@/lib/utils';
import type { LeaseCategory as LegacyLeaseCategory } from '@/types/lifecycle';
import type { LeaseCategory, WorkflowLeaseType } from '@/types/workflow';
import { CATEGORY_LABELS } from '@/types/lifecycle';

const ASSET_CATEGORY_ICONS: Record<LegacyLeaseCategory, typeof Building2> = {
  property: Building2,
  equipment: Settings,
  vehicle: Truck,
  other: Box,
};

interface NavigationState {
  workflowCategory?: LeaseCategory;
  workflowLeaseType?: WorkflowLeaseType;
  parentLeaseId?: string;
}

export default function NewLease() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isBusinessPlan, isLoading, createDraftLease } = useLifecycleWorkflow();

  const navState = location.state as NavigationState | null;

  // Workflow selectors
  const [workflowCategory, setWorkflowCategory] = useState<LeaseCategory>(
    navState?.workflowCategory || 'New Lease'
  );
  const [workflowLeaseType, setWorkflowLeaseType] = useState<WorkflowLeaseType>(
    navState?.workflowLeaseType || 'Real Estate'
  );
  const [parentLeaseId, setParentLeaseId] = useState<string | undefined>(navState?.parentLeaseId);
  const [assetCategory, setAssetCategory] = useState<LegacyLeaseCategory>('property');

  // Intake fields
  const [requestTitle, setRequestTitle] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [requestingDepartment, setRequestingDepartment] = useState('');
  const [leaseStart, setLeaseStart] = useState('');
  const [leaseEnd, setLeaseEnd] = useState('');
  const [monthlyRent, setMonthlyRent] = useState('');
  const [escalationType, setEscalationType] = useState('');
  const [escalationRate, setEscalationRate] = useState('');
  const [notes, setNotes] = useState('');

  // Derived term preview
  const termMonthsPreview =
    leaseStart && leaseEnd && leaseEnd > leaseStart
      ? Math.round(
          (new Date(leaseEnd).getTime() - new Date(leaseStart).getTime()) /
            ((365.25 / 12) * 24 * 60 * 60 * 1000)
        )
      : null;

  const canSubmit =
    requestTitle.trim() &&
    tenantName.trim() &&
    requestingDepartment.trim() &&
    monthlyRent &&
    parseFloat(monthlyRent) > 0 &&
    leaseStart &&
    leaseEnd &&
    leaseEnd > leaseStart &&
    (workflowCategory !== 'Lease Amendment' || parentLeaseId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const leaseId = await createDraftLease({
      category: assetCategory,
      businessUnit: requestingDepartment.trim(),
      requestTitle: requestTitle.trim(),
      tenantName: tenantName.trim(),
      requestingDepartment: requestingDepartment.trim(),
      monthlyRent: parseFloat(monthlyRent),
      leaseStart,
      leaseEnd,
      escalationType: escalationType || undefined,
      escalationRate:
        escalationType === 'percent' && escalationRate
          ? parseFloat(escalationRate)
          : undefined,
      notes: notes.trim() || undefined,
      workflowCategory,
      workflowLeaseType,
      parentLeaseId: workflowCategory === 'Lease Amendment' ? parentLeaseId : undefined,
    });

    if (leaseId) {
      navigate(`/app/leases/${leaseId}`);
    }
  };

  if (!isBusinessPlan) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 text-center">
          <h2 className="text-2xl font-semibold mb-2">Business Plan Required</h2>
          <p className="text-muted-foreground max-w-md mb-6">
            Lease workflow is available on the Business plan.
          </p>
          <Button onClick={() => navigate('/app/upgrade')}>Upgrade to Business</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title="New Lease Request"
        subtitle="Submit a commitment for review and approval"
        actions={
          <Button variant="outline" onClick={() => navigate('/app/dashboard')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
        }
      />

      <div className="p-6 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Workflow Category */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Category</CardTitle>
              <CardDescription>New commitment or amendment to an existing lease?</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <Button
                  type="button"
                  variant={workflowCategory === 'New Lease' ? 'default' : 'outline'}
                  className={cn(
                    'h-20 flex flex-col gap-2',
                    workflowCategory === 'New Lease' && 'ring-2 ring-primary ring-offset-2'
                  )}
                  onClick={() => { setWorkflowCategory('New Lease'); setParentLeaseId(undefined); }}
                >
                  <FilePlus className="h-6 w-6" />
                  <span>New Lease</span>
                </Button>
                <Button
                  type="button"
                  variant={workflowCategory === 'Lease Amendment' ? 'default' : 'outline'}
                  className={cn(
                    'h-20 flex flex-col gap-2',
                    workflowCategory === 'Lease Amendment' && 'ring-2 ring-primary ring-offset-2'
                  )}
                  onClick={() => setWorkflowCategory('Lease Amendment')}
                >
                  <FileEdit className="h-6 w-6" />
                  <span>Amendment</span>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Parent Lease */}
          {workflowCategory === 'Lease Amendment' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Parent Lease</CardTitle>
                <CardDescription>Select the lease being amended</CardDescription>
              </CardHeader>
              <CardContent>
                <ParentLeaseCombobox value={parentLeaseId} onValueChange={setParentLeaseId} />
              </CardContent>
            </Card>
          )}

          {/* Lease Type */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lease Type</CardTitle>
              <CardDescription>Real estate or equipment?</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <Button
                  type="button"
                  variant={workflowLeaseType === 'Real Estate' ? 'default' : 'outline'}
                  className={cn(
                    'h-20 flex flex-col gap-2',
                    workflowLeaseType === 'Real Estate' && 'ring-2 ring-primary ring-offset-2'
                  )}
                  onClick={() => setWorkflowLeaseType('Real Estate')}
                >
                  <Building2 className="h-6 w-6" />
                  <span>Real Estate</span>
                </Button>
                <Button
                  type="button"
                  variant={workflowLeaseType === 'Equipment' ? 'default' : 'outline'}
                  className={cn(
                    'h-20 flex flex-col gap-2',
                    workflowLeaseType === 'Equipment' && 'ring-2 ring-primary ring-offset-2'
                  )}
                  onClick={() => setWorkflowLeaseType('Equipment')}
                >
                  <Cpu className="h-6 w-6" />
                  <span>Equipment</span>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Request Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Request Details</CardTitle>
              <CardDescription>Identify this commitment and the requesting team</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="requestTitle">
                  Request Title <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="requestTitle"
                  placeholder="e.g. Austin HQ Expansion — 5th Floor"
                  value={requestTitle}
                  onChange={(e) => setRequestTitle(e.target.value)}
                  required
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="tenantName">
                  Tenant / Counterparty Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="tenantName"
                  placeholder="e.g. Acme Properties LLC"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  required
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="requestingDepartment">
                  Requesting Department <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="requestingDepartment"
                  placeholder="e.g. Operations"
                  value={requestingDepartment}
                  onChange={(e) => setRequestingDepartment(e.target.value)}
                  required
                  className="mt-1"
                />
              </div>
            </CardContent>
          </Card>

          {/* Asset Category */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Asset Category</CardTitle>
              <CardDescription>What type of asset is being leased?</CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={assetCategory}
                onValueChange={(v) => setAssetCategory(v as LegacyLeaseCategory)}
                className="grid grid-cols-2 gap-4"
              >
                {(Object.keys(CATEGORY_LABELS) as LegacyLeaseCategory[]).map((cat) => {
                  const Icon = ASSET_CATEGORY_ICONS[cat];
                  return (
                    <div key={cat}>
                      <RadioGroupItem value={cat} id={cat} className="peer sr-only" />
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

          {/* Lease Term */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lease Term</CardTitle>
              <CardDescription>Commencement and expiry dates</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="leaseStart">
                    Start Date <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="leaseStart"
                    type="date"
                    value={leaseStart}
                    onChange={(e) => setLeaseStart(e.target.value)}
                    required
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="leaseEnd">
                    End Date <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="leaseEnd"
                    type="date"
                    value={leaseEnd}
                    min={leaseStart || undefined}
                    onChange={(e) => setLeaseEnd(e.target.value)}
                    required
                    className="mt-1"
                  />
                </div>
              </div>
              {termMonthsPreview !== null && (
                <p className="text-xs text-muted-foreground mt-2">
                  Term: {termMonthsPreview} months
                </p>
              )}
            </CardContent>
          </Card>

          {/* Financial Terms */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Financial Terms</CardTitle>
              <CardDescription>Monthly commitment and escalation details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="monthlyRent">
                  Monthly Rent <span className="text-destructive">*</span>
                </Label>
                <div className="relative mt-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                  <Input
                    id="monthlyRent"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="5,000"
                    className="pl-7"
                    value={monthlyRent}
                    onChange={(e) => setMonthlyRent(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div>
                <Label className="mb-2 block">Escalation Type</Label>
                <RadioGroup
                  value={escalationType}
                  onValueChange={(v) => {
                    setEscalationType(v);
                    if (v !== 'percent') setEscalationRate('');
                  }}
                  className="flex flex-wrap gap-4"
                >
                  {[
                    { value: '', label: 'None' },
                    { value: 'percent', label: 'Fixed %' },
                    { value: 'index', label: 'CPI / Index' },
                  ].map(({ value, label }) => (
                    <div key={value || 'none'} className="flex items-center gap-2">
                      <RadioGroupItem value={value} id={`esc-${value || 'none'}`} />
                      <Label htmlFor={`esc-${value || 'none'}`} className="cursor-pointer font-normal">
                        {label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              {escalationType === 'percent' && (
                <div>
                  <Label htmlFor="escalationRate">Annual Escalation Rate</Label>
                  <div className="relative mt-1">
                    <Input
                      id="escalationRate"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      placeholder="3.0"
                      value={escalationRate}
                      onChange={(e) => setEscalationRate(e.target.value)}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
                  </div>
                </div>
              )}

              {escalationType === 'index' && (
                <p className="text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-md p-3">
                  CPI / index-based leases are flagged for manual rate review before the rent
                  schedule is finalized.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Notes</CardTitle>
              <CardDescription>Additional context for reviewers (optional)</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Background, urgency, special conditions…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
              />
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => navigate('/app/dashboard')}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading || !canSubmit}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting…
                </>
              ) : (
                'Submit Request'
              )}
            </Button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
