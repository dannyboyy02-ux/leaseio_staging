// SignatorReview — Phase 5 Checkpoint 4.
//
// Dedicated page for the signator to act on a lease at final_review.
// Intentional friction: the Approve button is gated behind a
// documents-reviewed checklist AND a ≥30-character intent-to-bind
// attestation. Send-back / Reject require a reason instead.
//
// Authorization: the page loads the lease's pending signator chain
// step. Access requires that the current user is either:
//   - the explicit approver_user_id on a pending signator step, OR
//   - holds the approver_role on a pending signator step
// Anyone else gets redirected to the lease detail page with a toast.
//
// Approve dispatches act-on-chain-step with action='approve' and
// comment=attestation. The edge function enforces a non-empty
// attestation server-side (defense-in-depth alongside the row-level
// CHECK on leases.signator_attestation_required).

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  Download,
  FileText,
  Loader2,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { documentTypeLabel } from '@/lib/leaseDocuments';

const ATTESTATION_MIN_CHARS = 30;

interface ChainStep {
  id: string;
  lease_id: string;
  workspace_id: string;
  stage: 'concept' | 'signator';
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  is_required: boolean;
  status: string;
}

interface LeaseRow {
  id: string;
  workspace_id: string;
  filename: string | null;
  lifecycle_status: string;
  monthly_payment: number | null;
  term_months: number | null;
  asset_type: string | null;
  lease_type: string | null;
  requesting_department: string | null;
  region: string | null;
  property_address: string | null;
  tenant_name: string | null;
  landlord_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  calc_total_commitment: number | null;
  calc_pv_liability: number | null;
}

interface DocRow {
  id: string;
  document_type: string;
  iteration_number: number;
  version_number: number;
  storage_path: string;
  filename: string;
  uploaded_at: string;
  is_current_latest: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return format(new Date(value), 'MMM d, yyyy');
  } catch {
    return value;
  }
}

export default function SignatorReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { user, workspace, userFunctionalRoles, isLoading: appLoading } = useApp();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);

  const [loading, setLoading] = useState(true);
  const [lease, setLease] = useState<LeaseRow | null>(null);
  const [step, setStep] = useState<ChainStep | null>(null);
  const [finalNegotiated, setFinalNegotiated] = useState<DocRow | null>(null);
  const [allDocs, setAllDocs] = useState<DocRow[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Action state
  const [docsReviewed, setDocsReviewed] = useState(false);
  const [termsReviewed, setTermsReviewed] = useState(false);
  const [authorityConfirmed, setAuthorityConfirmed] = useState(false);
  const [attestation, setAttestation] = useState('');
  const [busy, setBusy] = useState(false);

  // Reason dialog state (shared by reject + send_back)
  const [reasonOpen, setReasonOpen] = useState<null | 'reject' | 'send_back'>(null);
  const [reasonText, setReasonText] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!leaseId || appLoading || !user) return;

    async function load() {
      setLoading(true);
      setAuthError(null);
      try {
        // Load the lease
        const { data: leaseRow, error: leaseError } = await supabase
          .from('leases')
          .select(
            'id, workspace_id, filename, lifecycle_status, monthly_payment, term_months, asset_type, lease_type, requesting_department, region, property_address, tenant_name, landlord_name, lease_start, lease_end, calc_total_commitment, calc_pv_liability',
          )
          .eq('id', leaseId!)
          .maybeSingle();
        if (leaseError) throw leaseError;
        if (!leaseRow) {
          if (!cancelled) setAuthError('Lease not found');
          return;
        }
        if (cancelled) return;
        setLease(leaseRow as LeaseRow);

        if (leaseRow.lifecycle_status !== 'final_review') {
          if (!cancelled) {
            setAuthError(
              `This lease is in ${leaseRow.lifecycle_status}, not final_review. Signator review is only available at final_review.`,
            );
          }
          return;
        }

        // Load the pending signator chain step
        const { data: stepRows, error: stepError } = await supabase
          .from('lease_approval_chain')
          .select(
            'id, lease_id, workspace_id, stage, step_order, parallel_group, approver_user_id, approver_role, is_required, status',
          )
          .eq('lease_id', leaseId!)
          .eq('stage', 'signator')
          .eq('status', 'pending')
          .order('step_order', { ascending: true })
          .limit(1);
        if (stepError) throw stepError;
        const pendingStep = (stepRows as ChainStep[] | null)?.[0] ?? null;
        if (!pendingStep) {
          if (!cancelled) {
            setAuthError(
              'No pending signator step exists for this lease. The signator stage may have already been resolved or not yet inserted.',
            );
          }
          return;
        }
        if (cancelled) return;
        setStep(pendingStep);

        // Authorization: assignee user OR holds the role
        const isAssignedUser = pendingStep.approver_user_id === user!.id;
        const holdsRole = pendingStep.approver_role
          ? userFunctionalRoles.includes(pendingStep.approver_role as any)
          : false;
        if (!isAssignedUser && !holdsRole) {
          if (!cancelled) {
            setAuthError('You are not authorized to act on this signator step.');
          }
          return;
        }

        // Load documents
        const { data: docRows, error: docsError } = await supabase
          .from('lease_documents')
          .select(
            'id, document_type, iteration_number, version_number, storage_path, filename, uploaded_at, is_current_latest',
          )
          .eq('lease_id', leaseId!);
        if (docsError) throw docsError;
        const docs = (docRows ?? []) as DocRow[];
        if (cancelled) return;
        setAllDocs(docs);

        // Find the most recent final_negotiated doc (highest iteration,
        // then highest version)
        const fnDocs = docs
          .filter((d) => d.document_type === 'final_negotiated')
          .sort((a, b) => {
            if (a.iteration_number !== b.iteration_number) {
              return b.iteration_number - a.iteration_number;
            }
            return b.version_number - a.version_number;
          });
        const fn = fnDocs[0] ?? null;
        setFinalNegotiated(fn);

        // Generate signed URL for PDF preview
        if (fn) {
          const { data: signed } = await supabase.storage
            .from('lease-documents')
            .createSignedUrl(fn.storage_path, 600);
          if (!cancelled && signed?.signedUrl) {
            setPdfUrl(signed.signedUrl);
          }
        }
      } catch (err: any) {
        console.error('[SignatorReview] load error:', err);
        if (!cancelled) {
          setAuthError(err?.message || 'Failed to load signator review');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [leaseId, user, userFunctionalRoles, appLoading]);

  const checklistComplete = docsReviewed && termsReviewed && authorityConfirmed;
  const attestationLong = attestation.trim().length >= ATTESTATION_MIN_CHARS;
  const canApprove = checklistComplete && attestationLong && !busy && !!step;

  const placeholderHint = useMemo(() => {
    const wsName = workspace?.name || 'the company';
    if (finalNegotiated) {
      return `I confirm this lease commits ${wsName} to the terms in ${finalNegotiated.filename} (iteration ${finalNegotiated.iteration_number}, v${finalNegotiated.version_number}), and I have authority to bind the company.`;
    }
    return `I confirm this lease commits ${wsName} to the negotiated terms, and I have authority to bind the company.`;
  }, [workspace, finalNegotiated]);

  const handleApprove = async () => {
    if (!canApprove || !step) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('act-on-chain-step', {
        body: {
          chainStepId: step.id,
          action: 'approve',
          comment: attestation.trim(),
        },
      });
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || 'Failed to approve';
        toast.error(msg);
        return;
      }
      toast.success('Signator approval recorded. Lease moved to pending counter-signature.');
      navigate(`/app/leases/${leaseId}`);
    } catch (err: any) {
      console.error('[SignatorReview] approve error:', err);
      toast.error(err?.message || 'Failed to approve');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitReason = async () => {
    if (!reasonOpen || !step) return;
    const trimmed = reasonText.trim();
    if (trimmed.length === 0) {
      toast.error('Please provide a reason.');
      return;
    }
    setBusy(true);
    try {
      const action = reasonOpen;
      const { data, error } = await supabase.functions.invoke('act-on-chain-step', {
        body: {
          chainStepId: step.id,
          action,
          comment: trimmed,
        },
      });
      if (error || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || error?.message || 'Failed to submit';
        toast.error(msg);
        return;
      }
      toast.success(
        action === 'reject'
          ? 'Lease rejected.'
          : 'Lease returned to negotiation.',
      );
      setReasonOpen(null);
      setReasonText('');
      navigate(`/app/leases/${leaseId}`);
    } catch (err: any) {
      console.error('[SignatorReview] reason action error:', err);
      toast.error(err?.message || 'Failed to submit');
    } finally {
      setBusy(false);
    }
  };

  if (appLoading || loading) {
    return (
      <AppLayout>
        <AppHeader title="Signator Review" />
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (authError || !lease || !step) {
    return (
      <AppLayout>
        <AppHeader title="Signator Review" />
        <div className="max-w-2xl mx-auto py-10">
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Cannot proceed
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {authError || 'Unable to load signator review for this lease.'}
              </p>
              <Button
                variant="outline"
                onClick={() => navigate(leaseId ? `/app/leases/${leaseId}` : '/app/dashboard')}
              >
                <ChevronLeft className="h-4 w-4 mr-2" />
                Back to lease
              </Button>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <AppHeader
        title="Signator Review"
        subtitle={lease.filename || 'Untitled lease'}
      />

      <div className="max-w-6xl mx-auto py-6 space-y-6">
        {/* High-stakes banner */}
        <Card className="border-l-4 border-l-destructive">
          <CardContent className="py-4 flex items-start gap-3">
            <ShieldCheck className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-sm">
                This is the moment the company is legally committed.
              </p>
              <p className="text-xs text-muted-foreground">
                Approving advances this lease to counter-signature with a binding intent
                statement on the audit record. Reject if the deal is dead. Send back to
                negotiation if material terms still need to change.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: PDF preview */}
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Final Negotiated Document
                  </CardTitle>
                  {finalNegotiated && (
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        Iteration {finalNegotiated.iteration_number} · v
                        {finalNegotiated.version_number}
                      </Badge>
                      {pdfUrl && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => window.open(pdfUrl!, '_blank')}
                        >
                          <Download className="h-3.5 w-3.5 mr-1.5" />
                          Open
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!finalNegotiated ? (
                  <div className="border border-dashed rounded-md py-8 text-center text-muted-foreground text-sm">
                    No final negotiated document on file. Return to negotiation
                    and ask the submitter to upload one before proceeding.
                  </div>
                ) : pdfUrl ? (
                  <iframe
                    src={pdfUrl}
                    title={finalNegotiated.filename}
                    className="w-full h-[70vh] border rounded-md bg-muted/20"
                  />
                ) : (
                  <div className="border rounded-md py-12 flex items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Document timeline */}
            {allDocs.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Document History</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-xs">
                    {[...allDocs]
                      .sort((a, b) => {
                        if (a.iteration_number !== b.iteration_number)
                          return a.iteration_number - b.iteration_number;
                        return a.version_number - b.version_number;
                      })
                      .map((d) => (
                        <li
                          key={d.id}
                          className={cn(
                            'flex items-center justify-between gap-2 py-1 border-b last:border-b-0',
                            d.is_current_latest && 'font-medium',
                          )}
                        >
                          <span className="truncate">{d.filename}</span>
                          <span className="text-muted-foreground shrink-0">
                            {documentTypeLabel(d.document_type as any)} · It {d.iteration_number} v
                            {d.version_number} · {formatDate(d.uploaded_at)}
                          </span>
                        </li>
                      ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right column: summary + actions */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Lease Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <SummaryRow label="Tenant" value={lease.tenant_name} />
                <SummaryRow label="Landlord" value={lease.landlord_name} />
                <SummaryRow label="Address" value={lease.property_address} />
                <Separator />
                <SummaryRow
                  label="Asset type"
                  value={lease.lease_type || lease.asset_type}
                />
                <SummaryRow
                  label="Department"
                  value={lease.requesting_department}
                />
                <SummaryRow label="Region" value={lease.region} />
                <Separator />
                <SummaryRow
                  label="Term"
                  value={
                    lease.term_months ? `${lease.term_months} months` : null
                  }
                />
                <SummaryRow
                  label="Monthly payment"
                  value={formatCurrency(lease.monthly_payment)}
                />
                <SummaryRow
                  label="Total commitment"
                  value={formatCurrency(lease.calc_total_commitment)}
                />
                <SummaryRow
                  label="PV liability"
                  value={formatCurrency(lease.calc_pv_liability)}
                />
                <Separator />
                <SummaryRow label="Start" value={formatDate(lease.lease_start)} />
                <SummaryRow label="End" value={formatDate(lease.lease_end)} />
              </CardContent>
            </Card>

            {/* Documents Reviewed checklist + attestation */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Required Confirmations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <ChecklistItem
                    checked={docsReviewed}
                    onChange={setDocsReviewed}
                    label="I have reviewed the final negotiated document above"
                    disabled={!finalNegotiated || busy}
                  />
                  <ChecklistItem
                    checked={termsReviewed}
                    onChange={setTermsReviewed}
                    label="I have reviewed the key terms and financial impact in the summary"
                    disabled={busy}
                  />
                  <ChecklistItem
                    checked={authorityConfirmed}
                    onChange={setAuthorityConfirmed}
                    label="I have authority to bind the company to these terms"
                    disabled={busy}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="attestation" className="text-xs">
                    Intent-to-bind attestation (≥{ATTESTATION_MIN_CHARS} characters)
                  </Label>
                  <Textarea
                    id="attestation"
                    value={attestation}
                    onChange={(e) => setAttestation(e.target.value)}
                    placeholder={placeholderHint}
                    rows={4}
                    disabled={busy}
                    maxLength={2000}
                    className={cn(
                      attestationLong
                        ? 'border-success/50'
                        : attestation.length > 0
                        ? 'border-warning/50'
                        : '',
                    )}
                  />
                  <p
                    className={cn(
                      'text-[11px]',
                      attestationLong ? 'text-success' : 'text-muted-foreground',
                    )}
                  >
                    {attestation.trim().length} / {ATTESTATION_MIN_CHARS}+ characters
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Actions */}
            <Card>
              <CardContent className="py-4 space-y-2">
                <Button
                  className="w-full"
                  onClick={handleApprove}
                  disabled={!canApprove}
                  title={
                    !checklistComplete
                      ? 'Complete the checklist first'
                      : !attestationLong
                      ? `Attestation must be at least ${ATTESTATION_MIN_CHARS} characters`
                      : 'Approve and advance to counter-signature'
                  }
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  )}
                  Approve and Advance
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setReasonText('');
                    setReasonOpen('send_back');
                  }}
                  disabled={busy}
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Send Back to Negotiation
                </Button>
                <Button
                  variant="destructive"
                  className="w-full"
                  onClick={() => {
                    setReasonText('');
                    setReasonOpen('reject');
                  }}
                  disabled={busy}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Reason dialog */}
      <Dialog
        open={reasonOpen !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setReasonOpen(null);
            setReasonText('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reasonOpen === 'reject' ? 'Reject Lease' : 'Send Back to Negotiation'}
            </DialogTitle>
            <DialogDescription>
              {reasonOpen === 'reject'
                ? 'Rejecting moves the lease to a terminal state. Provide a reason for the audit log.'
                : 'Sending back returns the lease to in_negotiation. Provide a clear reason so the submitter knows what to revise.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              rows={4}
              maxLength={1000}
              disabled={busy}
              placeholder={
                reasonOpen === 'reject'
                  ? 'e.g., Counterparty walked away from agreed terms'
                  : 'e.g., Rent escalation cap needs to be reduced from 5% to 3%'
              }
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReasonOpen(null);
                setReasonText('');
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant={reasonOpen === 'reject' ? 'destructive' : 'default'}
              onClick={handleSubmitReason}
              disabled={busy || reasonText.trim().length === 0}
            >
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {reasonOpen === 'reject' ? 'Reject' : 'Send Back'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function SummaryRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right truncate">{value || '—'}</span>
    </div>
  );
}

function ChecklistItem({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2 cursor-pointer',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="text-sm">{label}</span>
    </label>
  );
}
