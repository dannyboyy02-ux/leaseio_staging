import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { format } from "date-fns";
import {
  FileText,
  CheckCircle,
  Save,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  GitBranch,
  DollarSign,
  Upload,
  Clock,
  X,
  RotateCcw,
} from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NudgeApproverButton } from "@/components/workflow/NudgeApproverButton";
import { isFailedStatus, needsReviewStatus } from "@/components/leases/LeaseStatusBadge";
import { NeedsReviewBanner } from "@/components/leases/NeedsReviewBanner";
import { FailedLeaseBanner } from "@/components/leases/FailedLeaseBanner";
import { SectionCard, RisksSection, SECTION_CONFIG, getFieldConfidence, type SectionKey } from "@/components/leases/LeaseReviewSections";
import { LeaseExports } from "@/components/leases/LeaseExports";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";
import { UploadAmendmentDialog } from "@/components/leases/UploadAmendmentDialog";
import { AmendmentsList } from "@/components/leases/AmendmentsList";
import { AmendmentChanges } from "@/components/leases/AmendmentChanges";
import { ActivityTimeline } from "@/components/lifecycle/ActivityTimeline";
import { LifecycleStatusBadge } from "@/components/lifecycle/LifecycleStatusBadge";
import { SummaryShareControls } from '@/components/summary/SummaryShareControls';
import { UploadExecutedDocumentDialog } from "@/components/leases/UploadExecutedDocumentDialog";
import { ExecutedTermsReview } from "@/components/leases/ExecutedTermsReview";
import { VarianceReport } from "@/components/leases/VarianceReport";
import { ModelLockConfirmation } from "@/components/leases/ModelLockConfirmation";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useApp } from "@/contexts/AppContext";
import { LOW_CONFIDENCE_THRESHOLD, type AuditEntry, type ConfidenceScores } from "@/types/workflow";
import { createLeaseNotification } from '@/lib/leaseNotifications';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';

interface ApprovalMetadata {
  approved: boolean;
  approved_at: string;
  approved_by: string;
}

interface ExtractedJson {
  property_address?: any;
  landlord_name?: any;
  tenant_name?: any;
  lease_start?: any;
  lease_end?: any;
  base_rent_amount?: any;
  monthly_rent?: any;
  security_deposit?: any;
  escalation_type?: any;
  current_monthly_rent?: any;
  rent_escalation_type?: any;
  square_footage?: any;
  rent_commencement_date?: any;
  base_rent_frequency?: any;
  renewal_options?: any;
  termination_clauses?: any;
  escalation_clauses?: any;
  _validation_warnings?: string[];
  _validation_suggestions?: string[];
  _approval?: ApprovalMetadata;
  _amendment_changes?: Array<{
    field: string;
    old_value: string | null;
    new_value: string | null;
    change_type?: 'modified' | 'added' | 'removed';
  }>;
}

// Tier-1 required fields that must be marked as reviewed before approval
const TIER1_REQUIRED_FIELDS = ['landlord_name', 'tenant_name', 'lease_start', 'lease_end'];

interface Risk {
  id: string;
  title: string;
  severity: string;
  explanation: string | null;
  citation_snippet: string | null;
  citation_page: number | null;
}

/**
 * Safely coerce any runtime value from extracted_json to a renderable string.
 * Guards against ExtractedField objects ({value, confidence, page, source_text})
 * being passed directly as React children (React error #31).
 */
function renderWarning(w: unknown): string {
  if (typeof w === 'string') return w;
  if (typeof w === 'number') return String(w);
  const extracted = getExtractedFieldValue(w);
  if (extracted) return extracted;
  try { return JSON.stringify(w); } catch { return String(w); }
}

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const { user } = useApp();
  
  const [lease, setLease] = useState<any | null>(null);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [basePdfUrl, setBasePdfUrl] = useState<string | null>(null);
  const [isPdfCollapsed, setIsPdfCollapsed] = useState(false);
  const [verifiedFields, setVerifiedFields] = useState<Set<string>>(new Set());
  const [confirmedSections, setConfirmedSections] = useState<string[]>([]);
  
  // Audit tracking
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const originalValues = useRef<Record<string, string>>({});
  
  // Low-confidence field interaction tracking
  const [interactedLowConfFields, setInteractedLowConfFields] = useState<Set<string>>(new Set());

  // Parent lease for amendments
  const [parentLease, setParentLease] = useState<any | null>(null);
  const [showParentTerms, setShowParentTerms] = useState(true);
  const [amendmentsRefresh, setAmendmentsRefresh] = useState(0);
  const [stageFile, setStageFile] = useState<File | null>(null);
  const [uploadingStageFile, setUploadingStageFile] = useState(false);
  const [runningAbstraction, setRunningAbstraction] = useState(false);
  const [editingRequest, setEditingRequest] = useState(false);
  const [requestEdits, setRequestEdits] = useState({
    request_title: '',
    requesting_department: '',
    request_urgency: '',
    vendor_name: '',
    request_description: '',
  });
  const [savingEdits, setSavingEdits] = useState(false);

  // Phase 2 — resubmit flow for returned leases
  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const [resubmitFields, setResubmitFields] = useState({
    monthlyPayment: '',
    termMonths: '',
    escalationRate: '',
    startDate: '',
    covenantFlagged: false,
  });
  const [resubmitting, setResubmitting] = useState(false);
  
  const isAmendment = !!lease?.parent_lease_id;
  const isMasterLease = !isAmendment && lease?.category !== 'Lease Amendment';

  // All field IDs from sections
  const allFieldIds = useMemo(() => {
    const ids: string[] = [];
    Object.values(SECTION_CONFIG).forEach(section => {
      section.fields.forEach(field => ids.push(field.id));
    });
    return ids;
  }, []);

  const [form, setForm] = useState<Record<string, string>>({});

  // Get confidence scores from lease
  const confidenceScores: ConfidenceScores = useMemo(() => {
    return (lease?.confidence_scores as ConfidenceScores) || {};
  }, [lease?.confidence_scores]);

  // Get low-confidence fields
  const lowConfidenceFields = useMemo(() => {
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    return allFieldIds.filter(fieldId => {
      const conf = getFieldConfidence(extractedJson, fieldId);
      return conf !== null && conf < LOW_CONFIDENCE_THRESHOLD / 100;
    });
  }, [lease?.extracted_json, allFieldIds]);

  // Check if all low-confidence fields have been interacted with
  const allLowConfFieldsInteracted = useMemo(() => {
    if (lowConfidenceFields.length === 0) return true;
    return lowConfidenceFields.every(field => interactedLowConfFields.has(field));
  }, [lowConfidenceFields, interactedLowConfFields]);

  // Check approval state from extracted_json
  const approvalState = useMemo(() => {
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    return extractedJson?._approval || null;
  }, [lease?.extracted_json]);
  
  const isApproved = !!approvalState?.approved;

  const lifecycleStatus = lease?.lifecycle_status;
  const isIntakeStage = lifecycleStatus === 'submitted' || lifecycleStatus === 'under_review' || lifecycleStatus === 'approved';

  // Check status states
  const isReviewRequired = lifecycleStatus === 'under_review';
  const isPendingApproval = false;
  const isProcessing = lease?.status === 'Processing' || lease?.status === 'Uploaded';
  const isPosted = lifecycleStatus === 'active';
  // Lock editing when approved, posted, or pending approval
  const isLocked = isPosted || isPendingApproval || isApproved;

  // Check if all Tier-1 required fields are reviewed (either confirmed via section or verified individually)
  const allTier1FieldsReviewed = useMemo(() => {
    // A field is considered "reviewed" if:
    // 1. Its section is confirmed, OR
    // 2. The field itself is in verifiedFields
    const sectionForField: Record<string, string> = {};
    Object.entries(SECTION_CONFIG).forEach(([sectionKey, section]) => {
      section.fields.forEach(field => {
        sectionForField[field.id] = sectionKey;
      });
    });

    return TIER1_REQUIRED_FIELDS.every(fieldId => {
      const sectionKey = sectionForField[fieldId];
      const sectionConfirmed = sectionKey && confirmedSections.includes(sectionKey);
      const fieldVerified = verifiedFields.has(fieldId);
      return sectionConfirmed || fieldVerified;
    });
  }, [confirmedSections, verifiedFields]);

  // Can approve only if: not processing, all Tier-1 fields reviewed
  const canApprove = !isProcessing && allTier1FieldsReviewed;

  const lifecycleSteps = [
    'submitted',
    'under_review',
    'approved',
    'executed',
    'active',
  ] as const;

  const currentLifecycleIndex = lifecycleSteps.findIndex((status) => status === lifecycleStatus);

  // Phase 2 — open resubmit dialog pre-populated with current values
  const openResubmit = () => {
    setResubmitFields({
      monthlyPayment: lease?.monthly_payment ? String(lease.monthly_payment) : '',
      termMonths: lease?.term_months ? String(lease.term_months) : '',
      escalationRate: lease?.escalation_rate != null ? String(lease.escalation_rate) : '0',
      startDate: lease?.lease_start || '',
      covenantFlagged: !!lease?.covenant_flagged,
    });
    setResubmitDialogOpen(true);
  };

  const handleResubmit = async () => {
    if (!lease || !user) return;
    setResubmitting(true);
    const now = new Date().toISOString();
    try {
      const monthlyPayment = parseFloat(resubmitFields.monthlyPayment) || lease.monthly_payment;
      const termMonths = parseInt(resubmitFields.termMonths) || lease.term_months;
      const escalationRate = parseFloat(resubmitFields.escalationRate) || 0;
      const startDate = resubmitFields.startDate || lease.lease_start;

      // Recalculate
      let updatedCalcs: Record<string, number | null> = {};
      if (monthlyPayment && termMonths && startDate) {
        const { calculateLease } = await import('@/lib/leaseCalculations');
        const wsResult = await (supabase as any)
          .from('workspaces')
          .select('discount_rate')
          .eq('id', lease.workspace_id)
          .single();
        const discountRate = wsResult.data?.discount_rate ?? 5.5;
        const calcs = calculateLease({ monthlyPayment, termMonths, startDate, escalationRate, discountRate });
        updatedCalcs = {
          calc_total_commitment: calcs.totalCashCommitment,
          calc_pv_liability: calcs.pvLiability,
          calc_straight_line_exp: calcs.straightLineExpense,
          calc_cash_pl_delta: calcs.cashPLDelta,
        };
      }

      // Re-evaluate approval routing
      const { getApprovalRequirements, getInitialStatusAfterSubmission } = await import('@/lib/approvalRouting');
      const [managerRoles, financialRoles, wsSettings] = await Promise.all([
        (supabase as any).from('workspace_roles').select('user_id').eq('workspace_id', lease.workspace_id).eq('role', 'manager_approver').then((r: any) => r.data || []),
        (supabase as any).from('workspace_roles').select('user_id').eq('workspace_id', lease.workspace_id).eq('role', 'financial_approver').then((r: any) => r.data || []),
        (supabase as any).from('workspaces').select('approval_threshold').eq('id', lease.workspace_id).single().then((r: any) => r.data),
      ]);

      const requirements = getApprovalRequirements({
        totalCashCommitment: updatedCalcs.calc_total_commitment ?? lease.calc_total_commitment ?? 0,
        approvalThreshold: wsSettings?.approval_threshold ?? null,
        hasManagerApprovers: managerRoles.length > 0,
        hasFinancialApprovers: financialRoles.length > 0,
        covenantFlagged: resubmitFields.covenantFlagged,
      });
      const newStatus = getInitialStatusAfterSubmission(requirements);

      await supabase
        .from('leases')
        .update({
          monthly_payment: monthlyPayment,
          term_months: termMonths,
          escalation_rate: escalationRate,
          lease_start: startDate,
          covenant_flagged: resubmitFields.covenantFlagged,
          financial_returned_to_submitter: false,
          financial_rejection_reason: null,
          manager_approved_by: null,
          manager_approved_at: null,
          manager_rejection_reason: null,
          lifecycle_status: newStatus,
          status_changed_at: now,
          ...updatedCalcs,
        } as any)
        .eq('id', lease.id);

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'resubmitted',
        from_status: 'submitted',
        to_status: newStatus,
        details: { monthly_payment: monthlyPayment, term_months: termMonths },
      } as any);

      toast.success('Resubmitted for review');
      setResubmitDialogOpen(false);
      setLease((prev: any) => prev ? { ...prev, lifecycle_status: newStatus, financial_returned_to_submitter: false } : prev);
    } catch (err) {
      console.error(err);
      toast.error('Failed to resubmit');
    } finally {
      setResubmitting(false);
    }
  };

  const renderStatusProgress = () => (
    <div className="mb-4 rounded-lg border bg-background p-3">
      <div className="grid grid-cols-5 gap-2">
        {lifecycleSteps.map((step, idx) => {
          const active = idx <= (currentLifecycleIndex === -1 ? -1 : currentLifecycleIndex);
          return (
            <div key={step} className="flex items-center gap-2">
              <div className={cn('h-2 w-full rounded-full', active ? 'bg-primary' : 'bg-muted')} />
              <span className={cn('text-[11px] capitalize', idx === currentLifecycleIndex ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                {step.replace(/_/g, ' ')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const updateLifecycleStatus = useCallback(async (newStatus: string) => {
    if (!lease || !user) return;

    const previousStatus = lease.lifecycle_status;
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('leases')
      .update({ lifecycle_status: newStatus, status_changed_at: now })
      .eq('id', lease.id);

    if (error) throw error;

    await supabase.from('lease_activity_log').insert({
      lease_id: lease.id,
      user_id: user.id,
      activity_type: 'status_change',
      from_status: previousStatus,
      to_status: newStatus,
      details: { source: 'lease_review' },
    });

    await createLeaseNotification({
      leaseId: lease.id,
      eventType: 'status_changed',
      description: `Lease status updated: ${previousStatus || 'unknown'} → ${newStatus}`,
    });

    setLease((prev: any) => (prev ? { ...prev, lifecycle_status: newStatus, status_changed_at: now } : prev));
  }, [lease, user]);

  const saveRequestEdits = useCallback(async () => {
    if (!lease || !user) return;
    setSavingEdits(true);
    try {
      const { error } = await supabase
        .from('leases')
        .update({
          request_title: requestEdits.request_title || null,
          requesting_department: requestEdits.requesting_department || null,
          request_urgency: requestEdits.request_urgency || 'standard',
          vendor_name: requestEdits.vendor_name || null,
          request_description: requestEdits.request_description || null,
          notes: requestEdits.request_description || null,
        })
        .eq('id', lease.id);

      if (error) throw error;

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'comment',
        details: { message: 'Request details updated', source: 'inline_edit' },
      });

      setLease((prev: any) => prev ? {
        ...prev,
        request_title: requestEdits.request_title,
        requesting_department: requestEdits.requesting_department,
        request_urgency: requestEdits.request_urgency,
        vendor_name: requestEdits.vendor_name,
        request_description: requestEdits.request_description,
        notes: requestEdits.request_description,
      } : prev);

      setEditingRequest(false);
      toast.success('Request details updated');
    } catch (err) {
      console.error('Error saving request edits:', err);
      toast.error('Failed to save changes');
    } finally {
      setSavingEdits(false);
    }
  }, [lease, user, requestEdits]);

  const handleStageDocumentUpload = useCallback(async () => {
    if (!lease || !user || !stageFile) {
      toast.error('Select a PDF file first');
      return;
    }

    setUploadingStageFile(true);
    try {
      const safeName = stageFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${user.id}/${lease.id}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from('leases')
        .upload(storagePath, stageFile, { upsert: false });

      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from('leases')
        .update({ storage_path: storagePath, filename: stageFile.name })
        .eq('id', lease.id);

      if (updateError) throw updateError;

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'document_upload',
        details: { filename: stageFile.name, stage: lease.lifecycle_status },
      });

      await createLeaseNotification({
        leaseId: lease.id,
        eventType: 'document_uploaded',
        description: `Document uploaded: ${stageFile.name}`,
      });

      setLease((prev: any) => (prev ? { ...prev, storage_path: storagePath, filename: stageFile.name } : prev));
      setStageFile(null);
      toast.success('Document uploaded');
    } catch (error) {
      console.error('Error uploading stage document:', error);
      toast.error('Failed to upload document');
    } finally {
      setUploadingStageFile(false);
    }
  }, [lease, stageFile, user]);

  const handleRunAbstraction = useCallback(async () => {
    if (!lease) return;

    setRunningAbstraction(true);
    try {
      let fileToProcess = stageFile;

      if (!fileToProcess && lease.storage_path) {
        const { data: existingFile, error: downloadError } = await supabase.storage
          .from('leases')
          .download(lease.storage_path);
        if (downloadError) throw downloadError;
        fileToProcess = new File([existingFile], lease.filename || 'lease.pdf', { type: 'application/pdf' });
      }

      if (!fileToProcess) {
        toast.error('Upload an executed document before running abstraction');
        return;
      }

      const formData = new FormData();
      formData.append('file', fileToProcess);
      formData.append('leaseType', lease.parent_lease_id ? 'amendment' : 'master');
      if (lease.parent_lease_id) formData.append('parentLeaseId', lease.parent_lease_id);

      const { data, error } = await supabase.functions.invoke('process_lease', { body: formData });
      if (error) throw error;

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user?.id || null,
        activity_type: 'comment',
        details: {
          message: 'Abstraction triggered',
          generated_lease_id: data?.leaseId || null,
        },
      });

      toast.success('Abstraction started');
      if (data?.leaseId) {
        navigate(`/app/leases/${data.leaseId}`);
      }
    } catch (error) {
      console.error('Error running abstraction:', error);
      toast.error('Failed to run abstraction');
    } finally {
      setRunningAbstraction(false);
    }
  }, [lease, navigate, stageFile, user?.id]);

  // Derived rent insights
  const derivedInsights = useMemo(() => {
    const rawRent = form.base_rent_amount || form.current_monthly_rent || "0";
    const startRent = parseFloat(rawRent.toString().replace(/[^0-9.]/g, "")) || 0;
    return { currentRent: startRent };
  }, [form.base_rent_amount, form.current_monthly_rent]);

  useEffect(() => {
    async function init() {
      if (!leaseId) return;
      
      // Fetch lease data
      const { data, error } = await supabase.from("leases").select("*").eq("id", leaseId).single();
      if (error) return;

      setLease(data);
      setRequestEdits({
        request_title: data.request_title || '',
        requesting_department: data.requesting_department || '',
        request_urgency: data.request_urgency || 'standard',
        vendor_name: data.vendor_name || '',
        request_description: data.request_description || data.notes || '',
      });
      const ext = (data.extracted_json as ExtractedJson) || {};

      // Build form from all section fields
      const formData: Record<string, string> = {};
      allFieldIds.forEach(fieldId => {
        // Priority: lease column > extracted_json value
        const leaseVal = data[fieldId];
        const extractedVal = getExtractedFieldValue(ext[fieldId as keyof ExtractedJson]) ?? "";
        formData[fieldId] = leaseVal != null ? String(leaseVal) : extractedVal;
      });
      
      setForm(formData);
      originalValues.current = { ...formData };
      
      // Load confirmed sections
      if (data.confirmed_sections && Array.isArray(data.confirmed_sections)) {
        setConfirmedSections(data.confirmed_sections);
      }
      
      // Load existing audit log
      if (data.audit_log && Array.isArray(data.audit_log)) {
        setAuditLog(data.audit_log as unknown as AuditEntry[]);
      }

      // Fetch rent schedule
      const { data: rs } = await supabase
        .from("rent_schedules")
        .select("*")
        .eq("lease_id", leaseId)
        .order("period_start");
      setRentSchedule(rs || []);

      // Fetch risks
      const { data: riskData } = await supabase
        .from("risks")
        .select("*")
        .eq("lease_id", leaseId);
      setRisks(riskData || []);

      // Get PDF URL
      if (data.storage_path) {
        const { data: urlData } = await supabase.storage.from("leases").createSignedUrl(data.storage_path, 3600);
        setPdfUrl(urlData?.signedUrl || null);
        setBasePdfUrl(urlData?.signedUrl || null);
      }
      setLoading(false);
    }
    init();

    // Set up polling if processing
    let pollInterval: NodeJS.Timeout | null = null;
    const pollForProcessingComplete = async () => {
      if (!leaseId) return;
      const { data, error } = await supabase
        .from("leases")
        .select("status, lifecycle_status")
        .eq("id", leaseId)
        .single();
      
      if (error) return;
      
      if (data.status !== lease?.status) {
        if (data.status === 'Ready' || data.status === 'Failed') {
          init();
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        }
      }
    };

    if (lease?.status === 'Processing' || lease?.status === 'Uploaded') {
      pollInterval = setInterval(pollForProcessingComplete, 3000);
    }

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [leaseId, lease?.status, allFieldIds]);

  // Fetch parent lease for amendments
  useEffect(() => {
    if (!lease?.parent_lease_id) return;
    
    const fetchParentLease = async () => {
      const { data, error } = await supabase
        .from('leases')
        .select('*')
        .eq('id', lease.parent_lease_id)
        .single();
      
      if (!error && data) {
        setParentLease(data);
      }
    };
    fetchParentLease();
  }, [lease?.parent_lease_id]);

  const jumpToPage = (page?: number) => {
    if (!page || !basePdfUrl) return;
    setPdfUrl(`${basePdfUrl}#page=${page}`);
    if (isPdfCollapsed) setIsPdfCollapsed(false);
  };

  // Handle field change with audit tracking
  const handleFieldChange = useCallback((fieldId: string, newValue: string) => {
    const oldValue = form[fieldId];
    setForm(prev => ({ ...prev, [fieldId]: newValue }));
    
    if (originalValues.current[fieldId] !== newValue && oldValue !== newValue) {
      const entry: AuditEntry = {
        field: fieldId,
        oldValue: oldValue || '',
        newValue: newValue,
        userId: user?.id || 'unknown',
        timestamp: new Date().toISOString(),
      };
      setAuditLog(prev => [...prev, entry]);
    }
  }, [form, user?.id]);

  // Track field corrections on blur
  const trackFieldCorrection = useCallback(async (fieldId: string) => {
    const originalValue = originalValues.current[fieldId];
    const currentValue = form[fieldId];
    
    if (originalValue === currentValue || !lease?.id) return;
    
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    const fieldConfidence = getFieldConfidence(extractedJson, fieldId);
    
    await supabase.from('field_corrections').insert({
      lease_id: lease.id,
      field_name: fieldId,
      original_value: originalValue || null,
      corrected_value: currentValue || null,
      ai_confidence: fieldConfidence,
      correction_type: !originalValue ? 'add_missing' : !currentValue ? 'delete_wrong' : 'edit'
    });
    
    originalValues.current[fieldId] = currentValue;
  }, [form, lease?.id, lease?.extracted_json]);

  // Track low-confidence field focus
  const handleFieldFocus = useCallback((fieldId: string) => {
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    const conf = getFieldConfidence(extractedJson, fieldId);
    if (conf !== null && conf < LOW_CONFIDENCE_THRESHOLD / 100) {
      setInteractedLowConfFields(prev => new Set([...prev, fieldId]));
    }
  }, [lease?.extracted_json]);

  // Toggle field verification
  const handleVerifyField = useCallback((fieldId: string) => {
    setVerifiedFields(prev => {
      const next = new Set(prev);
      if (next.has(fieldId)) {
        next.delete(fieldId);
      } else {
        next.add(fieldId);
      }
      return next;
    });
  }, []);

  // Confirm section as reviewed
  const handleConfirmSection = useCallback(async (sectionKey: string) => {
    const newConfirmed = [...confirmedSections, sectionKey];
    setConfirmedSections(newConfirmed);
    
    // Persist to database
    if (lease?.id) {
      await supabase
        .from('leases')
        .update({ confirmed_sections: newConfirmed })
        .eq('id', lease.id);
    }
  }, [confirmedSections, lease?.id]);

  // Phase 4 — refetch lease from DB (used after executed doc upload or term edits)
  const refetchLease = useCallback(async () => {
    if (!leaseId) return;
    const { data } = await supabase.from('leases').select('*').eq('id', leaseId).single();
    if (data) setLease(data);
  }, [leaseId]);

  // Save draft
  const handleSync = async () => {
    setSaving(true);
    try {
      // Build update object with only valid lease columns
      const updateData: Record<string, any> = {
        landlord_name: form.landlord_name || null,
        tenant_name: form.tenant_name || null,
        lease_start: form.lease_start || null,
        lease_end: form.lease_end || null,
        base_rent_amount: form.base_rent_amount || null,
        current_monthly_rent: form.current_monthly_rent ? parseFloat(form.current_monthly_rent.replace(/[^0-9.]/g, '')) || null : null,
        square_footage: form.square_footage ? parseFloat(form.square_footage) || null : null,
        rent_escalation_type: form.rent_escalation_type || null,
        confirmed_sections: confirmedSections,
        audit_log: JSON.parse(JSON.stringify(auditLog)),
      };

      const { error } = await supabase
        .from("leases")
        .update(updateData)
        .eq("id", lease.id);
      if (error) throw error;
      toast.success("Lease saved successfully");
    } catch (err) {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Post lease
  const handlePostLease = async () => {
    if (!allLowConfFieldsInteracted) {
      toast.error("Please review all highlighted fields before posting");
      return;
    }

    setPosting(true);
    try {
      const updateData: Record<string, any> = {
        landlord_name: form.landlord_name || null,
        tenant_name: form.tenant_name || null,
        lease_start: form.lease_start || null,
        lease_end: form.lease_end || null,
        base_rent_amount: form.base_rent_amount || null,
        status: 'Posted',
        lifecycle_status: 'active',
        confirmed_sections: confirmedSections,
        audit_log: JSON.parse(JSON.stringify(auditLog)),
      };

      const { error } = await supabase
        .from("leases")
        .update(updateData)
        .eq("id", lease.id);
      
      if (error) throw error;
      
      toast.success("Lease posted successfully", { duration: 5000 });
      navigate('/app/leases');
    } catch (err) {
      console.error('Error posting lease:', err);
      toast.error("Failed to post lease");
    } finally {
      setPosting(false);
    }
  };

  // Approve lease - stores approval in extracted_json._approval
  const handleApproveLease = async () => {
    if (!allTier1FieldsReviewed) {
      toast.error("Please mark all required fields (Landlord, Tenant, Lease Start, Lease End) as reviewed before approving");
      return;
    }

    setApproving(true);
    try {
      // First save any pending edits
      const updateData: Record<string, any> = {
        landlord_name: form.landlord_name || null,
        tenant_name: form.tenant_name || null,
        lease_start: form.lease_start || null,
        lease_end: form.lease_end || null,
        base_rent_amount: form.base_rent_amount || null,
        current_monthly_rent: form.current_monthly_rent ? parseFloat(form.current_monthly_rent.replace(/[^0-9.]/g, '')) || null : null,
        square_footage: form.square_footage ? parseFloat(form.square_footage) || null : null,
        rent_escalation_type: form.rent_escalation_type || null,
        confirmed_sections: confirmedSections,
        audit_log: JSON.parse(JSON.stringify(auditLog)),
      };

      // Add approval metadata to extracted_json
      const currentExtractedJson = (lease.extracted_json || {}) as ExtractedJson;
      const approvalMetadata: ApprovalMetadata = {
        approved: true,
        approved_at: new Date().toISOString(),
        approved_by: user?.id || 'unknown',
      };
      
      updateData.extracted_json = {
        ...currentExtractedJson,
        _approval: approvalMetadata,
      };

      const { error } = await supabase
        .from("leases")
        .update(updateData)
        .eq("id", lease.id);
      
      if (error) throw error;
      
      // Update local state
      setLease((prev: any) => ({
        ...prev,
        extracted_json: updateData.extracted_json,
      }));
      
      toast.success("Lease approved successfully");
    } catch (err) {
      console.error('Error approving lease:', err);
      toast.error("Failed to approve lease");
    } finally {
      setApproving(false);
    }
  };

  // Reopen lease - removes approval from extracted_json
  const handleReopenLease = async () => {
    setReopening(true);
    try {
      const currentExtractedJson = (lease.extracted_json || {}) as ExtractedJson;
      
      // Remove the approval metadata
      const { _approval, ...restExtractedJson } = currentExtractedJson;

      const { error } = await supabase
        .from("leases")
        .update({ extracted_json: restExtractedJson })
        .eq("id", lease.id);
      
      if (error) throw error;
      
      // Update local state
      setLease((prev: any) => ({
        ...prev,
        extracted_json: restExtractedJson,
      }));
      
      toast.success("Lease reopened for editing");
    } catch (err) {
      console.error('Error reopening lease:', err);
      toast.error("Failed to reopen lease");
    } finally {
      setReopening(false);
    }
  };

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center font-sans text-muted-foreground">Initializing Cockpit...</div>
    );

  // Show processing indicator
  if (isProcessing) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-6">
          <div className="relative mb-6">
            <div className="h-20 w-20 rounded-full border-4 border-muted flex items-center justify-center">
              <Loader2 className="h-10 w-10 text-primary animate-spin" />
            </div>
          </div>
          <h2 className="text-2xl font-semibold mb-2">Processing Lease</h2>
          <p className="text-muted-foreground text-center max-w-md mb-2">
            Our AI is extracting key terms and data from your document. This typically takes 30-90 seconds.
          </p>
          <p className="text-sm text-muted-foreground mb-6">{lease?.filename}</p>
          <Button variant="outline" onClick={() => navigate('/app/imports')}>
            View Import History
          </Button>
        </div>
      </AppLayout>
    );
  }

  const extractedJson = lease?.extracted_json as ExtractedJson | null;

  if (isIntakeStage && lease) {
    return (
      <AppLayout>
        <div className="p-6 space-y-4">
          <AppHeader
            title={lease.request_title || 'Lease Request'}
            subtitle={
              <div className="flex items-center gap-2">
                <LifecycleStatusBadge status={lease.lifecycle_status as any} />
                <span className="text-sm text-muted-foreground">{lease.requesting_department || 'Unknown department'}</span>
              </div>
            }
            actions={
              <div className="flex items-center gap-2">
                {lifecycleStatus === 'submitted' && (
                  <Button onClick={() => updateLifecycleStatus('under_review')}>Move to Under Review</Button>
                )}
                {lifecycleStatus === 'under_review' && (
                  <Button onClick={() => updateLifecycleStatus('approved')}>Move to Approved</Button>
                )}
                {lifecycleStatus === 'approved' && (
                  <Button onClick={() => updateLifecycleStatus('executed')}>Mark Executed</Button>
                )}
                {lifecycleStatus && !['active', 'expired', 'cancelled', 'rejected'].includes(lifecycleStatus) && (
                  <Button
                    variant="outline"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      if (window.confirm('Are you sure you want to cancel this lease request? This action cannot be undone.')) {
                        updateLifecycleStatus('cancelled');
                      }
                    }}
                  >
                    Cancel Request
                  </Button>
                )}
              </div>
            }
          />

          {renderStatusProgress()}

          {/* Phase 2 — Returned for Revision banner */}
          {lease?.financial_returned_to_submitter && lifecycleStatus === 'submitted' && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 flex flex-col sm:flex-row sm:items-start gap-3">
              <RotateCcw className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-amber-800 dark:text-amber-300">Returned for Revision</p>
                {lease?.financial_rejection_reason && (
                  <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                    "{lease.financial_rejection_reason}"
                  </p>
                )}
                <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">
                  Edit your financial inputs and resubmit to route through the approval chain again.
                </p>
              </div>
              <Button size="sm" variant="outline" className="flex-shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100" onClick={openResubmit}>
                <RotateCcw className="h-4 w-4 mr-1.5" />
                Edit &amp; Resubmit
              </Button>
            </div>
          )}

          {lifecycleStatus === 'cancelled' && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-center">
              <p className="text-sm font-medium text-destructive">This lease request has been cancelled</p>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Request Details</CardTitle>
                {(lifecycleStatus === 'submitted' || lifecycleStatus === 'under_review') && !editingRequest && (
                  <Button variant="ghost" size="sm" onClick={() => setEditingRequest(true)}>Edit</Button>
                )}
                {editingRequest && (
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => {
                      setEditingRequest(false);
                      setRequestEdits({
                        request_title: lease.request_title || '',
                        requesting_department: lease.requesting_department || '',
                        request_urgency: lease.request_urgency || 'standard',
                        vendor_name: lease.vendor_name || '',
                        request_description: lease.request_description || lease.notes || '',
                      });
                    }}>Cancel</Button>
                    <Button size="sm" disabled={savingEdits} onClick={saveRequestEdits}>
                      {savingEdits ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                      Save
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {editingRequest ? (
                  <>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Title</Label>
                      <input
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.request_title}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, request_title: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Department</Label>
                      <input
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.requesting_department}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, requesting_department: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Urgency</Label>
                      <select
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.request_urgency}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, request_urgency: e.target.value }))}
                      >
                        <option value="low">Low</option>
                        <option value="standard">Standard</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Vendor / Counterparty</Label>
                      <input
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.vendor_name}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, vendor_name: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Description / Notes</Label>
                      <textarea
                        rows={3}
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.request_description}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, request_description: e.target.value }))}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <p><span className="font-medium">Title:</span> {lease.request_title || '—'}</p>
                    <p><span className="font-medium">Department:</span> {lease.requesting_department || '—'}</p>
                    <p><span className="font-medium">Urgency:</span> <span className="capitalize">{lease.request_urgency || 'standard'}</span></p>
                    <p><span className="font-medium">Vendor:</span> {lease.vendor_name || '—'}</p>
                    <p><span className="font-medium">Notes:</span> {lease.request_description || lease.notes || '—'}</p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Attachments</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {lease.storage_path && lease.filename && (
                  <div className="flex items-center justify-between rounded-md border p-2.5 text-sm bg-muted/30">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">{lease.filename}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const { data } = await supabase.storage.from('leases').createSignedUrl(lease.storage_path, 120);
                        if (data?.signedUrl) window.open(data.signedUrl, '_blank');
                        else toast.error('Could not generate download link');
                      }}
                    >
                      Download
                    </Button>
                  </div>
                )}

                <div
                  className={cn(
                    'cursor-pointer rounded-lg border-2 border-dashed p-5 text-center transition-colors',
                    stageFile ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                  )}
                  onClick={() => document.getElementById('stage-file-input')?.click()}
                >
                  <input
                    id="stage-file-input"
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      setStageFile(e.target.files?.[0] || null);
                      if (e.target) e.target.value = '';
                    }}
                  />
                  <Upload className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {stageFile ? stageFile.name : 'Click to select a PDF or drag and drop'}
                  </p>
                </div>

                {stageFile && (
                  <div className="flex items-center justify-between rounded-md border p-2 text-sm">
                    <span className="truncate">{stageFile.name}</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setStageFile(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                <Button onClick={handleStageDocumentUpload} disabled={uploadingStageFile || !stageFile} variant="outline" className="w-full">
                  {uploadingStageFile ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                  Upload Document
                </Button>

                {/* Phase 4 — upload executed document when approved */}
                {lifecycleStatus === 'approved' && (
                  <UploadExecutedDocumentDialog
                    leaseId={lease.id}
                    leaseFilename={lease.filename || ''}
                    onSuccess={refetchLease}
                  />
                )}
              </CardContent>
            </Card>
          </div>

          {(lease.monthly_payment || lease.term_months) && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <DollarSign size={14} className="text-green-600" />
                    Financial Terms
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Monthly Payment</p>
                    <p className="font-medium">
                      {lease.monthly_payment ? `$${Number(lease.monthly_payment).toLocaleString()}` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Term</p>
                    <p className="font-medium">{lease.term_months ? `${lease.term_months} months` : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Asset Type</p>
                    <p className="font-medium capitalize">{lease.asset_type || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Escalation Rate</p>
                    <p className="font-medium">
                      {lease.escalation_rate != null ? `${lease.escalation_rate}% / yr` : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Start Date</p>
                    <p className="font-medium">
                      {lease.lease_start ? format(new Date(lease.lease_start), 'MMM d, yyyy') : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">End Date</p>
                    <p className="font-medium">
                      {lease.lease_start && lease.term_months ? (() => {
                        const end = new Date(lease.lease_start);
                        end.setMonth(end.getMonth() + Number(lease.term_months));
                        return format(end, 'MMM d, yyyy');
                      })() : '—'}
                    </p>
                  </div>
                </CardContent>
              </Card>

              {(lease.calc_total_commitment || lease.calc_pv_liability) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <DollarSign size={14} className="text-blue-600" />
                      Financial Impact
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {lease.covenant_flagged && (
                      <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
                        <AlertTriangle size={12} />
                        Covenant threshold may be impacted
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Total Cash Commitment</p>
                        <p className="font-medium">
                          {lease.calc_total_commitment
                            ? `$${Math.round(Number(lease.calc_total_commitment)).toLocaleString()}`
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Est. Lease Liability (PV)</p>
                        <p className="font-medium">
                          {lease.calc_pv_liability
                            ? `$${Math.round(Number(lease.calc_pv_liability)).toLocaleString()}`
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Monthly P&amp;L Charge</p>
                        <p className="font-medium">
                          {lease.calc_straight_line_exp
                            ? `$${Math.round(Number(lease.calc_straight_line_exp)).toLocaleString()}`
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Cash vs. P&amp;L Delta</p>
                        <p className="font-medium">
                          {lease.calc_cash_pl_delta != null
                            ? `$${Math.round(Number(lease.calc_cash_pl_delta)).toLocaleString()}`
                            : '—'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <p className="text-xs text-muted-foreground">Classification:</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-xs',
                          lease.lease_classification === 'pending' && 'border-amber-400 text-amber-700 bg-amber-50',
                          lease.lease_classification === 'operating' && 'border-green-400 text-green-700 bg-green-50',
                          lease.lease_classification === 'finance' && 'border-blue-400 text-blue-700 bg-blue-50',
                        )}
                      >
                        {lease.lease_classification === 'pending'
                          ? 'Pending Financial Review'
                          : lease.lease_classification === 'operating'
                          ? 'Operating Lease'
                          : lease.lease_classification === 'finance'
                          ? 'Finance Lease'
                          : '—'}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {lease.calc_total_commitment && (
            <SummaryShareControls
              leaseId={lease.id}
              lifecycleStatus={lease.lifecycle_status || ''}
            />
          )}

          <Card>
            <CardHeader><CardTitle>Activity Timeline</CardTitle></CardHeader>
            <CardContent>
              <ActivityTimeline leaseId={lease.id} />
            </CardContent>
          </Card>
        </div>

        {/* Phase 2 — Resubmit Dialog */}
        <Dialog open={resubmitDialogOpen} onOpenChange={(o) => !o && setResubmitDialogOpen(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Edit &amp; Resubmit</DialogTitle>
              <DialogDescription>
                Update the financial inputs below. The request will be routed through the approval chain from the beginning.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="rs-payment" className="text-sm">Monthly Payment ($)</Label>
                <Input
                  id="rs-payment"
                  type="number"
                  min={0}
                  step="0.01"
                  value={resubmitFields.monthlyPayment}
                  onChange={(e) => setResubmitFields((p) => ({ ...p, monthlyPayment: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="rs-term" className="text-sm">Term (months)</Label>
                  <Input
                    id="rs-term"
                    type="number"
                    min={1}
                    max={360}
                    value={resubmitFields.termMonths}
                    onChange={(e) => setResubmitFields((p) => ({ ...p, termMonths: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rs-esc" className="text-sm">Annual Escalation (%)</Label>
                  <Input
                    id="rs-esc"
                    type="number"
                    min={0}
                    step="0.1"
                    value={resubmitFields.escalationRate}
                    onChange={(e) => setResubmitFields((p) => ({ ...p, escalationRate: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rs-start" className="text-sm">Start Date</Label>
                <Input
                  id="rs-start"
                  type="date"
                  value={resubmitFields.startDate}
                  onChange={(e) => setResubmitFields((p) => ({ ...p, startDate: e.target.value }))}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="rs-covenant"
                  checked={resubmitFields.covenantFlagged}
                  onChange={(e) => setResubmitFields((p) => ({ ...p, covenantFlagged: e.target.checked }))}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                <label htmlFor="rs-covenant" className="text-sm cursor-pointer">
                  This commitment may impact financial covenants
                </label>
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setResubmitDialogOpen(false)} disabled={resubmitting}>
                Cancel
              </Button>
              <Button onClick={handleResubmit} disabled={resubmitting || !resubmitFields.monthlyPayment || !resubmitFields.termMonths}>
                {resubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <RotateCcw className="h-4 w-4 mr-2" />
                Resubmit for Review
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-muted/30">
        <AppHeader
          title="Lease Review"
          subtitle={
            <div className="flex items-center gap-2">
              <span>{lease.filename}</span>
              {lease.lifecycle_status && (
                <LifecycleStatusBadge status={lease.lifecycle_status as any} />
              )}
              {isApproved && (
                <Badge className="bg-green-600 text-white text-xs">
                  <CheckCircle size={12} className="mr-1" />
                  Approved
                </Badge>
              )}
              {isLocked && !isApproved && (
                <Badge variant="secondary" className="text-xs">
                  Read-only
                </Badge>
              )}
            </div>
          }
          actions={
            <div className="flex items-center gap-2">
              {/* Upload Amendment button - only for master leases */}
              {isMasterLease && !isProcessing && (
                <UploadAmendmentDialog
                  parentLeaseId={lease.id}
                  parentFilename={lease.filename}
                  onSuccess={() => setAmendmentsRefresh(prev => prev + 1)}
                />
              )}
              <LeaseExports
                lease={{
                  id: lease.id,
                  filename: lease.filename,
                  extracted_json: extractedJson,
                  landlord_name: lease.landlord_name,
                  tenant_name: lease.tenant_name,
                  lease_start: lease.lease_start,
                  lease_end: lease.lease_end,
                  base_rent_amount: lease.base_rent_amount,
                  current_monthly_rent: lease.current_monthly_rent,
                  status: lease.status,
                  lifecycle_status: lease.lifecycle_status,
                }}
                formValues={form}
                rentSchedule={rentSchedule}
              />
              {isPendingApproval && (
                <NudgeApproverButton 
                  leaseId={lease.id}
                  lastNudgedAt={lease.last_nudged_at}
                />
              )}
              {/* Reopen button - only shown when approved */}
              {isApproved && (
                <Button 
                  onClick={handleReopenLease} 
                  disabled={reopening} 
                  variant="outline"
                  className="text-amber-600 border-amber-400 hover:bg-amber-50"
                >
                  {reopening ? (
                    <Loader2 className="animate-spin mr-2" size={16} />
                  ) : (
                    <FileText className="mr-2" size={16} />
                  )}
                  Reopen
                </Button>
              )}
              {/* Save Draft - only when not locked */}
              {!isLocked && (
                <Button onClick={handleSync} disabled={saving} variant="outline">
                  {saving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
                  Save Draft
                </Button>
              )}
              {/* Approve Lease - only when not locked and not approved */}
              {!isLocked && !isApproved && (
                <Button 
                  onClick={handleApproveLease} 
                  disabled={approving || !canApprove}
                  className="bg-green-600 hover:bg-green-700"
                  title={!canApprove ? "Mark all required fields (Parties & Dates sections) as reviewed first" : "Approve this lease"}
                >
                  {approving ? (
                    <Loader2 className="animate-spin mr-2" size={16} />
                  ) : (
                    <CheckCircle className="mr-2" size={16} />
                  )}
                  Approve Lease
                </Button>
              )}
            </div>
          }
        />

        <div className="px-6 pt-4">{renderStatusProgress()}</div>

        <div className="flex-1 px-6 overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full rounded-xl border bg-background shadow-sm overflow-hidden"
          >
            {/* Left Panel: PDF Viewer */}
            <ResizablePanel
              defaultSize={50}
              collapsible={true}
              minSize={20}
              onCollapse={() => setIsPdfCollapsed(true)}
              onExpand={() => setIsPdfCollapsed(false)}
              className={cn(isPdfCollapsed && "min-w-0")}
            >
              <div className="flex h-full flex-col bg-muted/50 relative">
                <div className="p-2 border-b flex justify-between bg-background items-center">
                  <span className="text-[10px] font-bold uppercase text-muted-foreground px-2 tracking-tight">
                    Source Document
                  </span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsPdfCollapsed(true)}>
                    <ChevronLeft size={16} />
                  </Button>
                </div>
                {pdfUrl ? (
                  <iframe src={pdfUrl} className="w-full h-full border-none" title="Lease PDF" />
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    Document stream unavailable
                  </div>
                )}
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle className="bg-border w-1 hover:bg-primary transition-colors" />

            {/* Right Panel: Review Sections */}
            <ResizablePanel defaultSize={50} minSize={30}>
              <div className="flex h-full flex-col bg-background">
                <div className="p-2 border-b flex items-center bg-background">
                  {isPdfCollapsed && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 mr-2"
                      onClick={() => setIsPdfCollapsed(false)}
                    >
                      <ChevronRight size={16} />
                    </Button>
                  )}
                  <span className="text-[10px] font-bold uppercase text-muted-foreground tracking-tight">
                    Review &amp; Verification Panel
                  </span>
                  {lowConfidenceFields.length > 0 && (
                    <Badge variant="outline" className="ml-2 text-amber-600 border-amber-400">
                      <AlertTriangle size={10} className="mr-1" />
                      {lowConfidenceFields.length} fields need attention
                    </Badge>
                  )}
                </div>

                <ScrollArea className="flex-1 h-full">
                  <div className="p-6 space-y-6 max-w-2xl mx-auto pb-24">
                    {/* Failed Lease Banner */}
                    {isFailedStatus(lease?.status) && (
                      <FailedLeaseBanner
                        leaseId={lease.id}
                        errorMessage={lease.error_message}
                        storagePath={lease.storage_path}
                        onRetrySuccess={() => window.location.reload()}
                      />
                    )}

                    {/* Needs Review Banner */}
                    {needsReviewStatus(lease?.lifecycle_status) && (
                      <NeedsReviewBanner
                        landlordName={form.landlord_name}
                        tenantName={form.tenant_name}
                        leaseStart={form.lease_start}
                        leaseEnd={form.lease_end}
                        confidenceScores={confidenceScores}
                      />
                    )}

                    {/* Validation Warnings */}
                    {Array.isArray(extractedJson?._validation_warnings) && extractedJson._validation_warnings.length > 0 && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                        <div className="flex items-start gap-3">
                          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                          <div className="flex-1">
                            <h4 className="font-semibold text-amber-800 text-sm mb-1">Validation Warnings</h4>
                            <ul className="text-sm text-amber-700 space-y-1">
                              {extractedJson._validation_warnings.map((warning, i) => (
                                <li key={i} className="flex items-center gap-2">
                                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                  {renderWarning(warning)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Amendment: Parent Lease Comparison */}
                    {isAmendment && parentLease && (
                      <Collapsible open={showParentTerms} onOpenChange={setShowParentTerms}>
                        <Card className="shadow-none border border-blue-200 bg-blue-50/30 overflow-hidden">
                          <CollapsibleTrigger asChild>
                            <CardHeader className="cursor-pointer py-3 hover:bg-blue-100/50 transition-colors">
                              <CardTitle className="text-sm flex items-center justify-between">
                                <span className="flex items-center gap-2 text-blue-700">
                                  <GitBranch size={14} />
                                  Current Terms (Parent Lease)
                                </span>
                                <ChevronDown className={cn("h-4 w-4 text-blue-600 transition-transform", showParentTerms && "rotate-180")} />
                              </CardTitle>
                            </CardHeader>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <CardContent className="pt-0 pb-4 grid grid-cols-2 gap-4 text-sm">
                              <div>
                                <Label className="text-[10px] uppercase text-blue-600">Landlord</Label>
                                <p className="font-medium">{parentLease.landlord_name || 'N/A'}</p>
                              </div>
                              <div>
                                <Label className="text-[10px] uppercase text-blue-600">Tenant</Label>
                                <p className="font-medium">{parentLease.tenant_name || 'N/A'}</p>
                              </div>
                              <div>
                                <Label className="text-[10px] uppercase text-blue-600">Monthly Rent</Label>
                                <p className="font-medium">
                                  ${parentLease.current_monthly_rent?.toLocaleString() || parentLease.base_rent_amount || 'N/A'}
                                </p>
                              </div>
                              <div>
                                <Label className="text-[10px] uppercase text-blue-600">Lease End</Label>
                                <p className="font-medium">
                                  {parentLease.lease_end ? format(new Date(parentLease.lease_end), 'MMM d, yyyy') : 'N/A'}
                                </p>

                              </div>
                            </CardContent>
                          </CollapsibleContent>
                        </Card>
                      </Collapsible>
                    )}

                    {/* Amendment Changes - for amendment leases */}
                    {isAmendment && extractedJson?._amendment_changes && extractedJson._amendment_changes.length > 0 && (
                      <AmendmentChanges changes={extractedJson._amendment_changes} />
                    )}

                    {/* Section Cards */}
                    {(Object.keys(SECTION_CONFIG) as SectionKey[]).map((sectionKey) => (
                      <SectionCard
                        key={sectionKey}
                        sectionKey={sectionKey}
                        form={form}
                        extractedJson={extractedJson}
                        confidenceScores={confidenceScores}
                        verifiedFields={verifiedFields}
                        isLocked={isLocked}
                        onFieldChange={handleFieldChange}
                        onFieldFocus={handleFieldFocus}
                        onFieldBlur={trackFieldCorrection}
                        onVerifyField={handleVerifyField}
                        onJumpToPage={jumpToPage}
                        confirmedSections={confirmedSections}
                        onConfirmSection={handleConfirmSection}
                      />
                    ))}

                    {/* Phase 4 — Executed Document Section */}
                    {lifecycleStatus === 'executed' && (
                      <>
                        <ExecutedTermsReview
                          leaseId={lease.id}
                          pipelineTerms={{
                            tenant_name: form.tenant_name || null,
                            landlord_name: form.landlord_name || null,
                            commencement_date: form.lease_start || null,
                            expiry_date: form.lease_end || null,
                            monthly_payment: form.current_monthly_rent || null,
                            rent_review_clause: null,
                            break_clause: null,
                          }}
                          executedTerms={{
                            tenant_name: lease.executed_tenant_name ?? null,
                            landlord_name: lease.executed_landlord_name ?? null,
                            commencement_date: lease.executed_commencement_date ?? null,
                            expiry_date: lease.executed_expiry_date ?? null,
                            monthly_payment: lease.executed_monthly_payment != null ? String(lease.executed_monthly_payment) : null,
                            rent_review_clause: lease.executed_rent_review_clause ?? null,
                            break_clause: lease.executed_break_clause ?? null,
                            confidence: (lease.executed_confidence as Record<string, number>) || {},
                          }}
                          canEdit={!lease.model_locked}
                          onTermUpdated={refetchLease}
                        />
                        <VarianceReport
                          leaseFilename={lease.filename || ''}
                          pipelineMonthly={Number(lease.current_monthly_rent || lease.monthly_payment) || 0}
                          executedMonthly={Number(lease.executed_monthly_payment) || 0}
                          varianceMonthlyPayment={lease.variance_monthly_payment != null ? Number(lease.variance_monthly_payment) : null}
                          varianceCommencementDays={lease.variance_commencement_days != null ? Number(lease.variance_commencement_days) : null}
                          varianceExpiryDays={lease.variance_expiry_days != null ? Number(lease.variance_expiry_days) : null}
                          varianceTenantNameMatch={lease.variance_tenant_name_match != null ? Boolean(lease.variance_tenant_name_match) : null}
                          varianceLandlordNameMatch={lease.variance_landlord_name_match != null ? Boolean(lease.variance_landlord_name_match) : null}
                        />
                        <ModelLockConfirmation
                          leaseId={lease.id}
                          disabled={!!lease.model_locked}
                          onSuccess={refetchLease}
                        />
                      </>
                    )}

                    {/* Risks Section */}
                    <RisksSection risks={risks} onJumpToPage={jumpToPage} />

                    {/* Rent Schedule */}
                    <Card className="shadow-none border overflow-hidden">
                      <CardHeader className="bg-muted/30 border-b py-3">
                        <CardTitle className="text-sm font-bold flex items-center gap-2">
                          <DollarSign size={16} className="text-green-600" />
                          Rent Schedule
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-4">
                        <RentScheduleTable
                          rentSchedule={rentSchedule}
                          currentMonthlyRent={derivedInsights.currentRent}
                          rentEscalationType={form.rent_escalation_type || null}
                        />
                      </CardContent>
                    </Card>

                    {/* Amendments List - for master leases */}
                    {isMasterLease && (
                      <AmendmentsList 
                        parentLeaseId={lease.id} 
                        refreshTrigger={amendmentsRefresh}
                      />
                    )}

                    <Card className="shadow-none border overflow-hidden">
                      <CardHeader className="bg-muted/30 border-b py-3">
                        <CardTitle className="text-sm font-bold">Activity Timeline</CardTitle>
                      </CardHeader>
                      <CardContent className="pt-4">
                        <ActivityTimeline leaseId={lease.id} />
                      </CardContent>
                    </Card>
                  </div>
                </ScrollArea>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>

        {/* Sticky Post Lease Footer */}
        {isReviewRequired && (
          <div className="sticky bottom-0 border-t bg-background p-4 flex justify-between items-center shadow-lg">
            <div className="flex items-center gap-4">
              {lowConfidenceFields.length > 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  <span>
                    {allLowConfFieldsInteracted 
                      ? "All fields reviewed" 
                      : `${lowConfidenceFields.length - interactedLowConfFields.size} field(s) require attention`
                    }
                  </span>
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Ready to post</span>
              )}
              {auditLog.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {auditLog.length} change{auditLog.length !== 1 ? 's' : ''} tracked
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {confirmedSections.length}/{Object.keys(SECTION_CONFIG).length} sections reviewed
              </Badge>
            </div>
            <Button 
              disabled={!allLowConfFieldsInteracted || posting}
              onClick={handlePostLease}
              className="min-w-[140px]"
            >
              {posting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              Post Lease
            </Button>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
