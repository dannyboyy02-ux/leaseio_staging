import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AlertTriangle, Building2, Car, Cpu, Loader2, Package, Upload, X } from 'lucide-react';
import { toast } from 'sonner';

import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import { getApprovalRequirements, getInitialStatusAfterSubmission } from '@/lib/approvalRouting';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  createLeaseNotification,
  notifyChainAssignees,
  notifyRoleHolders,
} from '@/lib/leaseNotifications';
import { calculateLease } from '@/lib/leaseCalculations';
import type { LeaseCalculations } from '@/lib/leaseCalculations';
import {
  decideSubmissionOutcome,
  type ChainResult,
} from '@/lib/leaseSubmissionDecision';
import { FinancialImpactPreview } from './FinancialImpactPreview';

const leaseRequestSchema = z.object({
  assetType: z.enum(['equipment', 'vehicle', 'property', 'other']),
  description: z.string().trim().min(3, 'Description is required'),
  vendor: z.string().trim().optional(),
  requestingDepartment: z.string().trim().min(2, 'Requesting department is required'),
  // These three are optional — AI will extract them from the uploaded document.
  // Filling them in unlocks the financial impact preview and approval routing.
  monthlyPayment: z.coerce.number().positive().optional(),
  termMonths: z.coerce.number().int().min(1).max(360).optional(),
  startDate: z.string().optional(),
  escalationRate: z.coerce.number().min(0).default(0),
  covenantFlagged: z.boolean().default(false),
});

type LeaseRequestFormValues = z.infer<typeof leaseRequestSchema>;

interface LeaseRequestFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (leaseId: string) => void;
}

const ASSET_TYPE_OPTIONS = [
  { value: 'equipment', label: 'Equipment', icon: Cpu },
  { value: 'vehicle',   label: 'Vehicle',   icon: Car },
  { value: 'property',  label: 'Property',  icon: Building2 },
  { value: 'other',     label: 'Other',     icon: Package },
] as const;

export function LeaseRequestForm({ open, onOpenChange, onSuccess }: LeaseRequestFormProps) {
  const { user, workspace, userRole } = useApp();
  const isAdminRole = userRole === 'admin' || userRole === 'owner';
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [calcs, setCalcs] = useState<LeaseCalculations | null>(null);
  const [hasApprovers, setHasApprovers] = useState<boolean | null>(null);
  const [approvalRoleState, setApprovalRoleState] = useState({
    hasManagerApprovers: false,
    hasFinancialApprovers: false,
  });
  const [workspaceSettings, setWorkspaceSettings] = useState<{
    discountRate: number;
    approvalThreshold: number | null;
    covenantThreshold: number | null;
  }>({ discountRate: 5.5, approvalThreshold: null, covenantThreshold: null });

  const form = useForm<LeaseRequestFormValues>({
    resolver: zodResolver(leaseRequestSchema),
    defaultValues: {
      assetType: 'equipment',
      description: '',
      vendor: '',
      requestingDepartment: '',
      monthlyPayment: undefined as unknown as number,
      termMonths: undefined as unknown as number,
      startDate: '',
      escalationRate: 0,
      covenantFlagged: false,
    },
  });

  // Fetch workspace financial settings and approver check when form opens
  useEffect(() => {
    if (!open || !workspace?.id) return;
    supabase
      .from('workspaces')
      .select('discount_rate, covenant_threshold, approval_threshold')
      .eq('id', workspace.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setWorkspaceSettings({
            discountRate: (data as any).discount_rate ?? 5.5,
            approvalThreshold: (data as any).approval_threshold ?? null,
            covenantThreshold: (data as any).covenant_threshold ?? null,
          });
        }
      });

    // Check if workspace has any approval roles configured
    (supabase as any)
      .from('workspace_roles')
      .select('role')
      .eq('workspace_id', workspace.id)
      .in('role', ['manager_approver', 'financial_approver'])
      .then(({ data }: { data: Array<{ role: string }> | null }) => {
        const roles = data || [];
        setHasApprovers(roles.length > 0);
        setApprovalRoleState({
          hasManagerApprovers: roles.some((row) => row.role === 'manager_approver'),
          hasFinancialApprovers: roles.some((row) => row.role === 'financial_approver'),
        });
      });
  }, [open, workspace?.id]);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setCalcs(null);
      setHasApprovers(null);
      setApprovalRoleState({ hasManagerApprovers: false, hasFinancialApprovers: false });
      form.reset();
    }
  }, [open, form]);

  // Watch financial inputs for debounced live calculation
  const monthlyPayment = form.watch('monthlyPayment');
  const termMonths = form.watch('termMonths');
  const startDate = form.watch('startDate');
  const escalationRate = form.watch('escalationRate');
  const covenantFlagged = form.watch('covenantFlagged');
  const selectedAssetType = form.watch('assetType');

  useEffect(() => {
    const p = Number(monthlyPayment);
    const t = Number(termMonths);
    if (!p || !t || !startDate) {
      setCalcs(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        setCalcs(calculateLease({
          monthlyPayment: p,
          termMonths: t,
          startDate,
          escalationRate: Number(escalationRate) || 0,
          discountRate: workspaceSettings.discountRate,
        }));
      } catch {
        setCalcs(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [monthlyPayment, termMonths, startDate, escalationRate, workspaceSettings.discountRate]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length) setFile(acceptedFiles[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    maxSize: 20 * 1024 * 1024,
    accept: { 'application/pdf': ['.pdf'] },
  });

  const canSubmit = useMemo(
    () => !isSubmitting && !!user && !!workspace,
    [isSubmitting, user, workspace],
  );

  const approvalPreview = useMemo(() => {
    return getApprovalRequirements({
      totalCashCommitment: calcs?.totalCashCommitment ?? 0,
      approvalThreshold: workspaceSettings.approvalThreshold,
      hasManagerApprovers: approvalRoleState.hasManagerApprovers,
      hasFinancialApprovers: approvalRoleState.hasFinancialApprovers,
      covenantFlagged,
    });
  }, [
    approvalRoleState.hasFinancialApprovers,
    approvalRoleState.hasManagerApprovers,
    calcs?.totalCashCommitment,
    covenantFlagged,
    workspaceSettings.approvalThreshold,
  ]);

  const previewStatus = useMemo(
    () => getInitialStatusAfterSubmission(approvalPreview),
    [approvalPreview],
  );

  const submit = async (values: LeaseRequestFormValues) => {
    if (!user || !workspace) {
      toast.error('Please log in to submit a request');
      return;
    }

    setIsSubmitting(true);
    try {
      const now = new Date().toISOString();
      const fileName = file?.name ?? `${values.description}.request`;

      // ── Evaluate approval routing before inserting ──────────────────────
      const [wsSettings, managerRoles, financialRoles] = await Promise.all([
        (supabase as any)
          .from('workspaces')
          .select('approval_threshold')
          .eq('id', workspace.id)
          .single()
          .then((r: any) => r.data),
        (supabase as any)
          .from('workspace_roles')
          .select('user_id')
          .eq('workspace_id', workspace.id)
          .eq('role', 'manager_approver')
          .then((r: any) => r.data || []),
        (supabase as any)
          .from('workspace_roles')
          .select('user_id')
          .eq('workspace_id', workspace.id)
          .eq('role', 'financial_approver')
          .then((r: any) => r.data || []),
      ]);

      const approvalRequirements = getApprovalRequirements({
        totalCashCommitment: calcs?.totalCashCommitment ?? 0,
        approvalThreshold: wsSettings?.approval_threshold ?? null,
        hasManagerApprovers: managerRoles.length > 0,
        hasFinancialApprovers: financialRoles.length > 0,
        covenantFlagged: values.covenantFlagged,
      });

      // Legacy initial status — only used on the legacyFallback path
      // when no policies are configured.
      const legacyInitialStatus = getInitialStatusAfterSubmission(approvalRequirements);

      // Phase 2: insert as 'draft' first. Only flip to submitted/under_review/approved
      // AFTER chain resolution succeeds (or determines we should fall back).
      // This eliminates the half-state failure mode where a lease was inserted
      // in 'submitted' but had no resolved approvers because resolution then
      // failed — a real bug the spec called out.
      const { data: lease, error: createError } = await supabase
        .from('leases')
        .insert({
          user_id: user.id,
          workspace_id: workspace.id,
          requestor_id: user.id,
          request_title: values.description,
          category: values.assetType,
          asset_type: values.assetType,
          requesting_department: values.requestingDepartment,
          vendor_name: values.vendor || null,
          monthly_payment: values.monthlyPayment ?? null,
          term_months: values.termMonths ?? null,
          lease_start: values.startDate || null,
          escalation_rate: values.escalationRate ?? 0,
          covenant_flagged: values.covenantFlagged,
          lease_classification: 'pending',
          calc_total_commitment: calcs?.totalCashCommitment ?? null,
          calc_pv_liability: calcs?.pvLiability ?? null,
          calc_straight_line_exp: calcs?.straightLineExpense ?? null,
          calc_cash_pl_delta: calcs?.cashPLDelta ?? null,
          lifecycle_status: 'draft',
          intake_source: 'request_workflow',
          // Lease requests don't go through AI abstraction — set Ready so the
          // processing spinner never fires when landing on the detail page.
          status: 'Ready',
          lease_owner_id: user.id,
          initializer_id: user.id,
          filename: fileName,
          uploaded_at: now,
          status_changed_at: now,
        } as any)
        .select('id')
        .single();

      if (createError || !lease) throw createError ?? new Error('Failed to create lease request');

      if (file) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `${user.id}/${lease.id}/${Date.now()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from('leases')
          .upload(storagePath, file, { upsert: false });
        if (uploadError) throw uploadError;
        await supabase
          .from('leases')
          .update({ storage_path: storagePath, filename: file.name })
          .eq('id', lease.id);
      }

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'created',
        to_status: 'draft',
        details: {
          description: values.description,
          requesting_department: values.requestingDepartment,
          monthly_payment: values.monthlyPayment,
          term_months: values.termMonths,
          has_attachment: Boolean(file),
        },
      } as any);

      // Phase 2: resolve approval chain. Two outcomes that proceed:
      //   - legacyFallback=true → workspace has no policies; use the legacy
      //     getApprovalRequirements/notifyRoleHolders path exactly as before.
      //   - matched policy → chain rows already written by the edge function;
      //     notify the first stage's assignees.
      // Any other outcome (ambiguous match, no_match_no_fallback,
      // separation_violation, network error) leaves the lease in 'draft'
      // and surfaces a toast — the spec's stated "lease stays in draft"
      // half-state-eliminating contract.
      const { data: chainResult, error: chainError } = await supabase.functions.invoke(
        'resolve-approval-chain',
        { body: { leaseId: lease.id, initialResolution: true } },
      );

      const chain = chainResult as ChainResult;

      // Phase 3: pure decision in src/lib/leaseSubmissionDecision.ts so the
      // four submission outcomes are unit-testable.
      const outcome = decideSubmissionOutcome(chain, legacyInitialStatus, chainError);
      if (outcome.kind === 'leave_draft') {
        toast.error(outcome.errorMessage);
        // Lease stays in 'draft'; resolve-approval-chain is idempotent on
        // initialResolution=true so the user can retry.
        return;
      }

      const finalStatus = outcome.finalStatus;
      const routingPath = outcome.routingPath;

      // Apply the flip + notify the right approvers for the chosen path.
      await supabase
        .from('leases')
        .update({ lifecycle_status: finalStatus, status_changed_at: new Date().toISOString() } as any)
        .eq('id', lease.id);

      if (routingPath === 'legacy') {
        if (finalStatus === 'submitted' && approvalRequirements.requiresManagerApproval) {
          await notifyRoleHolders(
            supabase,
            lease.id,
            workspace.id,
            'manager_approver',
            `New commitment request awaiting your review: ${values.description}`,
          );
        } else if (
          finalStatus === 'under_review' &&
          approvalRequirements.requiresFinancialApproval
        ) {
          await notifyRoleHolders(
            supabase,
            lease.id,
            workspace.id,
            'financial_approver',
            `New commitment request awaiting financial review: ${values.description}`,
          );
        }
      } else {
        // Chain path — chain rows already inserted by the edge function.
        await notifyChainAssignees(
          supabase,
          lease.id,
          workspace.id,
          outcome.chainSuccess!.firstStepAssignees,
          `New commitment request requires your approval: ${values.description}`,
        );
      }

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'status_change',
        from_status: 'draft',
        to_status: finalStatus,
        details: {
          triggered_by: 'request_submission',
          routing_path: routingPath,
          ...(routingPath === 'chain' && outcome.chainSuccess
            ? {
                policy_id: outcome.chainSuccess.policyId,
                policy_version: outcome.chainSuccess.policyVersion,
                policy_name: outcome.chainSuccess.policyName,
                steps_created: outcome.chainSuccess.stepsCreated,
              }
            : {
                auto_approved: finalStatus === 'approved',
              }),
        },
      } as any);

      await createLeaseNotification({
        leaseId: lease.id,
        eventType: 'new_request',
        description: `New commitment request: ${values.description}`,
      });

      toast.success('Request submitted');
      onOpenChange(false);
      onSuccess?.(lease.id);
      navigate(`/app/leases/${lease.id}`);
    } catch (error) {
      console.error('Failed to submit lease request:', error);
      toast.error('Failed to submit request');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>New Commitment Request</SheetTitle>
          <SheetDescription>
            Enter lease terms to see the financial impact before you submit.
          </SheetDescription>
        </SheetHeader>

        {/* No-approvers warning */}
        {hasApprovers === false && (
          <div className="mx-4 mt-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/20 dark:border-amber-700">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">No approvers configured</p>
              {/* The reader is typically a non-admin submitter — the Members
                  section is admin-only, so a link would silently bounce them
                  to My Workspaces. Admins get the direct link; everyone else
                  gets plain "ask your admin" text. */}
              {isAdminRole ? (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                  This request will be auto-approved. Assign approval roles in{' '}
                  <Link
                    to="/app/settings/workspaces/users"
                    className="underline"
                    onClick={() => onOpenChange(false)}
                  >
                    Workspaces → Members
                  </Link>.
                </p>
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                  This request will be auto-approved. Ask your admin to assign
                  approval roles under Workspaces → Members.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="mx-4 mt-4 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-sm font-medium">Approval route preview</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">Submit</Badge>
            {approvalPreview.requiresManagerApproval && <Badge variant="secondary">Manager review</Badge>}
            {approvalPreview.requiresFinancialApproval && <Badge variant="secondary">Financial review</Badge>}
            <Badge variant={previewStatus === 'approved' ? 'default' : 'outline'}>
              {previewStatus === 'approved' ? 'Auto-approved' : 'Posted after approval'}
            </Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {approvalPreview.requiresFinancialApproval
              ? covenantFlagged
                ? 'Financial review is required because this request is covenant-flagged.'
                : workspaceSettings.approvalThreshold != null &&
                  (calcs?.totalCashCommitment ?? 0) >= workspaceSettings.approvalThreshold
                ? `Financial review is required because the total commitment meets or exceeds the $${Math.round(workspaceSettings.approvalThreshold).toLocaleString()} threshold.`
                : 'Financial review is required based on your workspace approval settings.'
              : 'No additional reviewers are required with the current values.'}
          </p>
        </div>

        <div className="px-4 pb-4 overflow-y-auto">
          <Form {...form}>
            <form
              id="lease-request-form"
              onSubmit={form.handleSubmit(submit)}
              className="space-y-6"
            >
              {/* ——— Commitment Details ——— */}
              <div className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Commitment Details
                </p>

                <FormField
                  control={form.control}
                  name="assetType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Asset Type</FormLabel>
                      <div className="grid grid-cols-4 gap-2">
                        {ASSET_TYPE_OPTIONS.map((option) => {
                          const Icon = option.icon;
                          const selected = selectedAssetType === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => field.onChange(option.value)}
                              className={cn(
                                'rounded-lg border p-3 text-left transition-colors',
                                selected
                                  ? 'border-primary bg-primary/5'
                                  : 'border-border hover:border-primary/30',
                              )}
                            >
                              <div className="flex flex-col items-center gap-1 text-xs font-medium">
                                <Icon className="h-4 w-4" />
                                {option.label}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Description <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="What is being leased?" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="vendor"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Vendor</FormLabel>
                      <FormControl>
                        <Input placeholder="Vendor name (optional)" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="requestingDepartment"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Requesting Department <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="Operations" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <Separator />

              {/* ——— Lease Terms ——— */}
              <div className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Lease Terms
                </p>

                <FormField
                  control={form.control}
                  name="monthlyPayment"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Monthly Payment
                        <span className="ml-1 text-xs font-normal text-muted-foreground">(AI will extract from document)</span>
                      </FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                            $
                          </span>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="5,000"
                            className="pl-7"
                            value={field.value ?? ''}
                            onChange={(e) =>
                              field.onChange(
                                e.target.value === '' ? undefined : Number(e.target.value),
                              )
                            }
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="termMonths"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Term (months)
                          <span className="ml-1 text-xs font-normal text-muted-foreground">(AI will extract)</span>
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={1}
                            max={360}
                            placeholder="60"
                            value={field.value ?? ''}
                            onChange={(e) =>
                              field.onChange(
                                e.target.value === '' ? undefined : Number(e.target.value),
                              )
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="escalationRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Annual Escalation (%)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="0.1"
                            placeholder="3.0"
                            value={field.value ?? ''}
                            onChange={(e) =>
                              field.onChange(
                                e.target.value === '' ? 0 : Number(e.target.value),
                              )
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Start Date
                        <span className="ml-1 text-xs font-normal text-muted-foreground">(AI will extract)</span>
                      </FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      {calcs?.endDate && (
                        <p className="text-xs text-muted-foreground">
                          End date: {calcs.endDate}
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* ——— Live Financial Impact Preview ——— */}
              {calcs && (
                <FinancialImpactPreview
                  calculations={calcs}
                  covenantFlagged={covenantFlagged}
                  covenantThreshold={workspaceSettings.covenantThreshold}
                  discountRate={workspaceSettings.discountRate}
                  termMonths={Number(termMonths)}
                />
              )}

              <Separator />

              {/* ——— Document ——— */}
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Document
                </p>
                <Label className="text-sm font-normal text-muted-foreground">
                  Attach Quote / Draft Lease (optional PDF, max 20 MB)
                </Label>
                <div
                  {...getRootProps()}
                  className={cn(
                    'cursor-pointer rounded-lg border-2 border-dashed p-5 text-center transition-colors',
                    isDragActive
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/40',
                  )}
                >
                  <input {...getInputProps()} />
                  <Upload className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {file ? file.name : 'Drop PDF here or click to browse'}
                  </p>
                </div>
                {file && (
                  <div className="flex items-center justify-between rounded-md border p-2 text-sm">
                    <span className="truncate">{file.name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      type="button"
                      onClick={() => setFile(null)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </form>
          </Form>
        </div>

        <SheetFooter>
          <Button type="submit" form="lease-request-form" disabled={!canSubmit}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit Request
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
