import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  ClipboardCheck,
  Pencil,
  Unlock,
  Lock,
  Plus,
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
import { type ImperativePanelHandle } from "react-resizable-panels";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NudgeApproverButton } from "@/components/workflow/NudgeApproverButton";
import { isFailedStatus, needsReviewStatus } from "@/components/leases/LeaseStatusBadge";
import { NeedsReviewBanner } from "@/components/leases/NeedsReviewBanner";
import { FailedLeaseBanner } from "@/components/leases/FailedLeaseBanner";
import { SectionCard, RisksSection, SECTION_CONFIG, getFieldConfidence, type SectionKey } from "@/components/leases/LeaseReviewSections";
import { AddRiskDialog, type PendingCitation } from "@/components/leases/AddRiskDialog";
import { LeaseExports } from "@/components/leases/LeaseExports";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";
import { UploadAmendmentDialog } from "@/components/leases/UploadAmendmentDialog";
import { AmendmentsList } from "@/components/leases/AmendmentsList";
import { AmendmentChanges } from "@/components/leases/AmendmentChanges";
import { ActivityTimeline } from "@/components/lifecycle/ActivityTimeline";
import { PdfViewer } from "@/components/leases/PdfViewer";
import { LifecycleStatusBadge } from "@/components/lifecycle/LifecycleStatusBadge";
import { SummaryShareControls } from '@/components/summary/SummaryShareControls';
import { UploadExecutedDocumentDialog } from "@/components/leases/UploadExecutedDocumentDialog";
import { ExecutedTermsReview } from "@/components/leases/ExecutedTermsReview";
import { VarianceReport } from "@/components/leases/VarianceReport";
import { LeaseDocumentsTab } from "@/components/leases/LeaseDocumentsTab";
import { LockedLeaseDetail } from "@/components/leases/locked/LockedLeaseDetail";
import { ArchiveButton } from "@/components/leases/ArchiveButton";

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
  const { user, userRole, userFunctionalRoles } = useApp();
  const queryClient = useQueryClient();
  
  const [lease, setLease] = useState<any | null>(null);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [addRiskOpen, setAddRiskOpen] = useState<boolean>(false);
  const [pdfCaptureMode, setPdfCaptureMode] = useState<boolean>(false);
  const [pendingCapture, setPendingCapture] = useState<PendingCitation | null>(null);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isPdfCollapsed, setIsPdfCollapsed] = useState(false);
  const pdfPanelRef = useRef<ImperativePanelHandle>(null);
  const [targetPage, setTargetPage] = useState<number | undefined>(undefined);
  const [targetHighlight, setTargetHighlight] = useState<string | undefined>(undefined);
  const [targetValue, setTargetValue] = useState<string | undefined>(undefined);
  const [verifiedFields, setVerifiedFields] = useState<Set<string>>(new Set());
  const [confirmedSections, setConfirmedSections] = useState<string[]>([]);
  
  // Audit tracking
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const originalValues = useRef<Record<string, string>>({});
  const processingStartTime = useRef<number | null>(null);
  
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
    vendor_name: '',
    request_description: '',
    asset_type: '',
    region: '',
    location: '',
    building: '',
    vendor_address_line1: '',
    vendor_address_line2: '',
    vendor_city: '',
    vendor_state: '',
    vendor_zip: '',
    vendor_phone: '',
  });
  const [savingEdits, setSavingEdits] = useState(false);
  const [pendingUnlockRequest, setPendingUnlockRequest] = useState<any>(null);
  const [activeChangeSet, setActiveChangeSet] = useState<any>(null);
  const [stagedItemCount, setStagedItemCount] = useState(0);
  const [submittingChanges, setSubmittingChanges] = useState(false);

  // Active tab in the review panel
  const [activeTab, setActiveTab] = useState('general');
  const [cancelChangeSetDialogOpen, setCancelChangeSetDialogOpen] = useState(false);
  const [lockConfirmDialogOpen, setLockConfirmDialogOpen] = useState(false);
  const [cancelingChangeSet, setCancelingChangeSet] = useState(false);

  const [assetTypes, setAssetTypes] = useState<string[]>(['Real Estate', 'Equipment', 'Vehicle', 'Other']);
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);
  const [regionOptions, setRegionOptions] = useState<string[]>([]);
  const [locationOptions, setLocationOptions] = useState<string[]>([]);
  const [buildingOptions, setBuildingOptions] = useState<string[]>([]);

  // Phase 2 — resubmit flow for returned leases
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const [resubmitFields, setResubmitFields] = useState({
    monthlyPayment: '',
    termMonths: '',
    escalationRate: '',
    startDate: '',
    covenantFlagged: false,
  });
  const [resubmitting, setResubmitting] = useState(false);

  // Processing cancel state
  const [cancellingProcessing, setCancellingProcessing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  
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

  // Active lease unlocked for staged editing
  const isUnlockedForEditing = isPosted && !lease?.model_locked && activeChangeSet?.status === 'draft';

  // Show PDF panel alongside tabs when lease is still editable/in-review.
  // Hide it (full-width tabs) when the lease is active and fully locked.
  const showPdfPanel = lifecycleStatus !== 'active' || !lease?.model_locked;

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
        activity_type: 'status_change',
        from_status: 'submitted',
        to_status: newStatus,
        details: { action: 'resubmitted', monthly_payment: monthlyPayment, term_months: termMonths },
      } as any);

      toast.success('Resubmitted for review');
      setResubmitDialogOpen(false);
      setLease((prev: any) => prev ? { ...prev, lifecycle_status: newStatus, financial_returned_to_submitter: false } : prev);
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
    } catch (err) {
      console.error(err);
      toast.error('Failed to resubmit');
    } finally {
      setResubmitting(false);
    }
  };

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
      description: `Lease status updated: ${previousStatus || 'unknown'} \u2192 ${newStatus}`,
    });

    setLease((prev: any) => (prev ? { ...prev, lifecycle_status: newStatus, status_changed_at: now } : prev));
    queryClient.invalidateQueries({ queryKey: ['needs-action'] });
  }, [lease, user, queryClient]);

  const saveRequestEdits = useCallback(async () => {
    if (!lease || !user) return;
    setSavingEdits(true);
    try {
      const { error } = await supabase
        .from('leases')
        .update({
          request_title: requestEdits.request_title || null,
          requesting_department: requestEdits.requesting_department || null,
          vendor_name: requestEdits.vendor_name || null,
          request_description: requestEdits.request_description || null,
          notes: requestEdits.request_description || null,
          asset_type: (requestEdits.asset_type || null) as any,
          region: (requestEdits.region || null) as any,
          location: (requestEdits.location || null) as any,
          building: (requestEdits.building || null) as any,
          vendor_address_line1: (requestEdits.vendor_address_line1 || null) as any,
          vendor_address_line2: (requestEdits.vendor_address_line2 || null) as any,
          vendor_city: (requestEdits.vendor_city || null) as any,
          vendor_state: (requestEdits.vendor_state || null) as any,
          vendor_zip: (requestEdits.vendor_zip || null) as any,
          vendor_phone: (requestEdits.vendor_phone || null) as any,
        } as any)
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
        vendor_name: requestEdits.vendor_name,
        request_description: requestEdits.request_description,
        notes: requestEdits.request_description,
        asset_type: requestEdits.asset_type,
        region: requestEdits.region,
        location: requestEdits.location,
        building: requestEdits.building,
        vendor_address_line1: requestEdits.vendor_address_line1,
        vendor_address_line2: requestEdits.vendor_address_line2,
        vendor_city: requestEdits.vendor_city,
        vendor_state: requestEdits.vendor_state,
        vendor_zip: requestEdits.vendor_zip,
        vendor_phone: requestEdits.vendor_phone,
      } : prev);

      setEditingRequest(false);
      toast.success('Report attributes updated');
    } catch (err) {
      console.error('Error saving request edits:', err);
      toast.error('Failed to save changes');
    } finally {
      setSavingEdits(false);
    }
  }, [lease, user, requestEdits]);

  const refreshStagedItemCount = useCallback(async () => {
    if (!activeChangeSet?.id) return;
    const { count } = await (supabase as any)
      .from('lease_change_set_items')
      .select('*', { count: 'exact', head: true })
      .eq('change_set_id', activeChangeSet.id);
    setStagedItemCount(count ?? 0);
  }, [activeChangeSet?.id]);

  const stageFieldChange = useCallback(async (changeSetId: string, fieldName: string, fieldLabel: string, oldValue: string | null, newValue: string) => {
    if (!newValue || oldValue === newValue) return;
    const { error } = await (supabase as any)
      .from('lease_change_set_items')
      .upsert({
        change_set_id: changeSetId,
        field_name: fieldName,
        field_label: fieldLabel,
        old_value: String(oldValue ?? ''),
        proposed_value: newValue,
        source_section: 'section_card',
      }, { onConflict: 'change_set_id,field_name' });
    if (error) console.error('[LeaseReview] stage field error:', error);
    else await refreshStagedItemCount();
  }, [refreshStagedItemCount]);


  const saveRename = useCallback(async () => {
    if (!lease) return;
    const trimmed = renameValue.trim();
    const { error } = await supabase
      .from('leases')
      .update({ request_title: trimmed || null })
      .eq('id', lease.id);
    if (error) {
      toast.error('Failed to rename lease');
      return;
    }
    setLease((prev: any) => prev ? { ...prev, request_title: trimmed || null } : prev);
    setRenameDialogOpen(false);
    toast.success('Lease renamed');
  }, [lease, renameValue]);

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

  // Derived rent insights — prefer current period from schedule over the initial extracted value
  const derivedInsights = useMemo(() => {
    if (rentSchedule.length > 0) {
      const today = new Date();
      const currentPeriod = rentSchedule.find(p => {
        const start = new Date(p.period_start);
        const end = p.period_end ? new Date(p.period_end) : null;
        return start <= today && (!end || end >= today);
      });
      if (currentPeriod?.monthly_amount) {
        return { currentRent: currentPeriod.monthly_amount };
      }
    }
    const rawRent = form.base_rent_amount || form.current_monthly_rent || "0";
    const startRent = parseFloat(rawRent.toString().replace(/[^0-9.]/g, "")) || 0;
    return { currentRent: startRent };
  }, [form.base_rent_amount, form.current_monthly_rent, rentSchedule]);

  useEffect(() => {
    async function init() {
      if (!leaseId) { setLoading(false); return; }
      try {
        // Fetch lease data
        const { data, error } = await supabase.from("leases").select("*").eq("id", leaseId).single();
        if (error) { console.error('[LeaseReview] Failed to load lease:', error.message); return; }

        setLease(data);
        setRequestEdits({
          request_title: data.request_title || '',
          requesting_department: data.requesting_department || '',
          vendor_name: data.vendor_name || '',
          request_description: data.request_description || data.notes || '',
          asset_type: (data as any).asset_type || '',
          region: (data as any).region || '',
          location: (data as any).location || '',
          building: (data as any).building || '',
          vendor_address_line1: (data as any).vendor_address_line1 || '',
          vendor_address_line2: (data as any).vendor_address_line2 || '',
          vendor_city: (data as any).vendor_city || '',
          vendor_state: (data as any).vendor_state || '',
          vendor_zip: (data as any).vendor_zip || '',
          vendor_phone: (data as any).vendor_phone || '',
        });
        const ext = (data.extracted_json as ExtractedJson) || {};

        // Build form from all section fields
        const formData: Record<string, string> = {};
        allFieldIds.forEach(fieldId => {
          const leaseVal = data[fieldId];
          const extractedVal = getExtractedFieldValue(ext[fieldId as keyof ExtractedJson]) ?? "";
          formData[fieldId] = leaseVal != null ? String(leaseVal) : extractedVal;
        });

        setForm(formData);
        originalValues.current = { ...formData };

        if (data.confirmed_sections && Array.isArray(data.confirmed_sections)) {
          setConfirmedSections(data.confirmed_sections);
        }
        if (data.audit_log && Array.isArray(data.audit_log)) {
          setAuditLog(data.audit_log as unknown as AuditEntry[]);
        }

        // Fetch rent schedule, risks, PDF URL, workspace asset types, and governance state in parallel
        const [rsResult, riskResult, pdfResult, wsResult, unlockResult, changeSetResult] = await Promise.all([
          supabase.from("rent_schedules").select("*").eq("lease_id", leaseId).order("period_start"),
          supabase.from("risks").select("*").eq("lease_id", leaseId).is("dismissed_at", null),
          data.storage_path
            ? supabase.storage.from("leases").createSignedUrl(data.storage_path, 3600)
            : Promise.resolve(null),
          data.workspace_id
            ? (supabase as any).from("workspaces").select("asset_type_config, department_options, region_options, location_options, building_options").eq("id", data.workspace_id).single()
            : Promise.resolve(null),
          (supabase as any)
            .from('lease_unlock_requests')
            .select('id, status, requested_by, request_reason, created_at')
            .eq('lease_id', leaseId)
            .eq('status', 'pending')
            .maybeSingle(),
          (supabase as any)
            .from('lease_change_sets')
            .select('id, status, submitted_by, change_summary, submitted_at, created_at')
            .eq('lease_id', leaseId)
            .in('status', ['draft', 'pending_approval'])
            .order('created_at', { ascending: false })
            .limit(1),
        ]);

        setRentSchedule(rsResult.data || []);
        setRisks(riskResult.data || []);
        setPendingUnlockRequest(unlockResult.data ?? null);
        const csRowsInit = (changeSetResult as any).data;
        setActiveChangeSet(Array.isArray(csRowsInit) && csRowsInit.length > 0 ? csRowsInit[0] : null);
        if (wsResult?.data?.asset_type_config && Array.isArray(wsResult.data.asset_type_config)) {
          setAssetTypes(wsResult.data.asset_type_config as string[]);
        }
        if (wsResult?.data?.department_options && Array.isArray(wsResult.data.department_options)) {
          setDepartmentOptions(wsResult.data.department_options as string[]);
        }
        if (wsResult?.data?.region_options && Array.isArray(wsResult.data.region_options)) {
          setRegionOptions(wsResult.data.region_options as string[]);
        }
        if (wsResult?.data?.location_options && Array.isArray(wsResult.data.location_options)) {
          setLocationOptions(wsResult.data.location_options as string[]);
        }
        if (wsResult?.data?.building_options && Array.isArray(wsResult.data.building_options)) {
          setBuildingOptions(wsResult.data.building_options as string[]);
        }
        if (pdfResult && 'data' in pdfResult) {
          if ('error' in pdfResult && pdfResult.error) {
            console.error('[LeaseReview] Failed to get PDF URL:', (pdfResult.error as any).message);
          }
          setPdfUrl((pdfResult.data as any)?.signedUrl || null);
        }
      } catch (err) {
        console.error('[LeaseReview] init() error:', err);
      } finally {
        setLoading(false);
      }
    }
    init();

    // Set up polling if processing
    let pollInterval: NodeJS.Timeout | null = null;
    let elapsedInterval: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const pollForProcessingComplete = async () => {
      if (!leaseId) return;
      const { data, error } = await supabase
        .from("leases")
        .select("status, lifecycle_status")
        .eq("id", leaseId)
        .single();
      
      if (error) return;
      
      if (data.status === 'Ready' || data.status === 'Failed') {
        init();
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      }
    };

    if (lease?.status === 'Processing' || lease?.status === 'Uploaded') {
      if (!processingStartTime.current) {
        processingStartTime.current = Date.now();
      }
      pollInterval = setInterval(pollForProcessingComplete, 3000);

      // Elapsed time counter
      elapsedInterval = setInterval(() => {
        if (processingStartTime.current) {
          setElapsedSeconds(Math.floor((Date.now() - processingStartTime.current) / 1000));
        }
      }, 1000);

      // Auto-cancel after 3 minutes
      timeoutTimer = setTimeout(async () => {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; }
        await supabase
          .from('leases')
          .update({ status: 'Failed', error_message: 'Processing timed out after 3 minutes' })
          .eq('id', leaseId);
        init();
      }, 180_000);
    } else {
      processingStartTime.current = null;
      setElapsedSeconds(0);
    }

    return () => {
      if (pollInterval) clearInterval(pollInterval);
      if (elapsedInterval) clearInterval(elapsedInterval);
      if (timeoutTimer) clearTimeout(timeoutTimer);
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

  /**
   * Unified lock action — replaces the legacy ModelLockConfirmation.
   * - When there's a draft change set with staged items: submits the changes
   *   for financial approval (status=pending_approval) and re-locks the lease.
   * - Otherwise: initial activation. Sets lifecycle_status=active, model_locked=true,
   *   model_locked_at, model_locked_by.
   */
  const handleLockAction = async () => {
    if (!lease) return;
    if (activeChangeSet?.status === 'draft' && stagedItemCount > 0) {
      await handleSubmitChanges();
      return;
    }
    setSubmittingChanges(true);
    try {
      const { data: { user: authedUser } } = await supabase.auth.getUser();
      if (!authedUser) throw new Error('Not authenticated');
      const now = new Date().toISOString();
      const fromStatus = (lease as any).lifecycle_status ?? 'executed';
      const { error } = await supabase
        .from('leases')
        .update({
          model_locked: true,
          model_locked_at: now,
          model_locked_by: authedUser.id,
          lifecycle_status: 'active',
        } as any)
        .eq('id', lease.id);
      if (error) throw new Error(`Lock failed: ${error.message}`);
      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: authedUser.id,
        activity_type: 'status_change',
        from_status: fromStatus,
        to_status: 'active',
        details: { action: 'model_locked', locked_at: now },
      });
      toast.success('Lease locked and activated');
      refetchLease();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to lock lease');
    } finally {
      setSubmittingChanges(false);
    }
  };

  const jumpToPage = (page?: number, sourceText?: string, value?: string) => {
    if (!page) return;
    setTargetPage(page);
    setTargetHighlight(sourceText);
    setTargetValue(value);
    if (showPdfPanel) {
      if (isPdfCollapsed) setIsPdfCollapsed(false);
    } else {
      // PDF lives in the Documents tab when the panel is hidden
      setActiveTab('documents');
    }
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

    // Stage change when unlocked for governance editing
    if (isUnlockedForEditing && activeChangeSet?.id) {
      const fieldLabel = Object.values(SECTION_CONFIG)
        .flatMap(s => s.fields)
        .find(f => f.id === fieldId)?.label ?? fieldId;
      await stageFieldChange(activeChangeSet.id, fieldId, fieldLabel, originalValue ?? null, currentValue);
    }

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
  }, [form, lease?.id, lease?.extracted_json, isUnlockedForEditing, activeChangeSet?.id, stageFieldChange]);

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

  // Rent schedule: persist inline edits
  const handleScheduleChange = useCallback(async (updated: RentScheduleEntry[]) => {
    setRentSchedule(updated);
    if (!leaseId) return;
    // Upsert all rows, delete removed ones
    const existingIds = rentSchedule.map(r => r.id);
    const updatedIds = updated.map(r => r.id);
    const deletedIds = existingIds.filter(id => !updatedIds.includes(id) && !id.startsWith('new-'));
    if (deletedIds.length > 0) {
      await supabase.from('rent_schedules').delete().in('id', deletedIds);
    }
    for (const row of updated) {
      if (row.id.startsWith('new-')) {
        const { id: _id, ...rest } = row;
        await supabase.from('rent_schedules').insert({ ...rest, lease_id: leaseId });
      } else {
        await supabase.from('rent_schedules').update({
          period_start: row.period_start,
          period_end: row.period_end,
          monthly_amount: row.monthly_amount,
          annual_amount: row.annual_amount,
          notes: row.notes,
        }).eq('id', row.id);
      }
    }
    // Re-fetch to get server-assigned IDs for new rows
    const { data } = await supabase.from('rent_schedules').select('*').eq('lease_id', leaseId).order('period_start');
    if (data) setRentSchedule(data);
  }, [leaseId, rentSchedule]);

  // Rent schedule: auto-generate
  const handleGenerateSchedule = useCallback(async (mode: 'single' | 'annual') => {
    if (!leaseId || !form.lease_start || !form.base_rent_amount) return;
    const baseRent = parseFloat(form.base_rent_amount.replace(/[^0-9.]/g, '')) || 0;
    if (!baseRent) { toast.error('Base rent amount is required to generate a schedule'); return; }
    const startDate = new Date(form.lease_start);
    const endDate = form.lease_end ? new Date(form.lease_end) : null;
    const rows: Omit<RentScheduleEntry, 'id'>[] = [];
    if (mode === 'single') {
      rows.push({
        period_start: startDate.toISOString().split('T')[0],
        period_end: endDate ? endDate.toISOString().split('T')[0] : null,
        monthly_amount: baseRent,
        annual_amount: baseRent * 12,
        notes: 'Generated — single period',
        lease_id: leaseId,
      } as any);
    } else {
      const escalationRate = lease?.escalation_rate ? Number(lease.escalation_rate) / 100 : 0;
      if (!escalationRate) { toast.error('Escalation rate is required for annual schedule generation'); return; }
      let current = startDate;
      let rent = baseRent;
      const end = endDate ?? new Date(startDate.getFullYear() + 5, startDate.getMonth(), startDate.getDate());
      while (current < end) {
        const next = new Date(current.getFullYear() + 1, current.getMonth(), current.getDate());
        const periodEnd = next > end ? end : new Date(next.getTime() - 86400000);
        rows.push({
          period_start: current.toISOString().split('T')[0],
          period_end: periodEnd.toISOString().split('T')[0],
          monthly_amount: Math.round(rent * 100) / 100,
          annual_amount: Math.round(rent * 12 * 100) / 100,
          notes: null,
          lease_id: leaseId,
        } as any);
        rent = rent * (1 + escalationRate);
        current = next;
      }
    }
    const { error } = await supabase.from('rent_schedules').insert(rows);
    if (error) { toast.error('Failed to generate schedule'); return; }
    const { data } = await supabase.from('rent_schedules').select('*').eq('lease_id', leaseId).order('period_start');
    if (data) setRentSchedule(data);
    toast.success('Rent schedule generated');
  }, [leaseId, form.lease_start, form.lease_end, form.base_rent_amount, lease?.escalation_rate]);

  // Phase 4 — refetch lease from DB (used after executed doc upload or term edits)
  const refetchLease = useCallback(async () => {
    if (!leaseId) return;
    const [{ data }, unlockResult, changeSetResult] = await Promise.all([
      supabase.from('leases').select('*').eq('id', leaseId).single(),
      (supabase as any)
        .from('lease_unlock_requests')
        .select('id, status, requested_by, request_reason, created_at')
        .eq('lease_id', leaseId)
        .eq('status', 'pending')
        .maybeSingle(),
      (supabase as any)
        .from('lease_change_sets')
        .select('id, status, submitted_by, change_summary, submitted_at, created_at')
        .eq('lease_id', leaseId)
        .in('status', ['draft', 'pending_approval'])
        .order('created_at', { ascending: false })
        .limit(1),
    ]);
    if (data) setLease(data);
    setPendingUnlockRequest(unlockResult.data ?? null);
    // Use array form + take first; duplicate drafts (rare) would make
    // maybeSingle() return null and break the unlock-edit flow.
    const csRows = (changeSetResult as any).data;
    setActiveChangeSet(Array.isArray(csRows) && csRows.length > 0 ? csRows[0] : null);
  }, [leaseId]);

  const handleCancelChangeSet = useCallback(async () => {
    if (!lease || !user || !activeChangeSet?.id) return;
    setCancelingChangeSet(true);
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: { action: 'cancel_change_set', changeSetId: activeChangeSet.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      setCancelChangeSetDialogOpen(false);
      toast.success('Changes discarded. Lease re-locked.');
      refetchLease();
    } catch (err) {
      console.error('Error canceling change set:', err);
      toast.error('Failed to discard changes');
    } finally {
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      setCancelingChangeSet(false);
    }
  }, [lease, user, activeChangeSet, refetchLease]);

  // Save draft
  const handleSync = async () => {
    setSaving(true);
    try {
      // Build update object with only valid lease columns
      const updateData: Record<string, any> = {
        landlord_name:          form.landlord_name          || null,
        tenant_name:            form.tenant_name            || null,
        vendor_name:            form.vendor_name            || null,
        property_address:       form.property_address       || null,
        asset_type:             form.asset_type             || null,
        location:               form.location               || null,
        building:               form.building               || null,
        region:                 form.region                 || null,
        lease_start:            form.lease_start            || null,
        lease_end:              form.lease_end              || null,
        rent_commencement_date: form.rent_commencement_date || null,
        term_months:            form.term_months ? parseInt(form.term_months) || null : null,
        base_rent_amount:       form.base_rent_amount       || null,
        current_monthly_rent:   form.current_monthly_rent ? parseFloat(form.current_monthly_rent.replace(/[^0-9.]/g, '')) || null : null,
        square_footage:         form.square_footage ? parseFloat(form.square_footage) || null : null,
        security_deposit:       form.security_deposit       || null,
        renewal_options:        form.renewal_options        || null,
        escalation_clauses:     form.escalation_clauses     || null,
        termination_clauses:    form.termination_clauses    || null,
        rent_escalation_type:   form.rent_escalation_type   || null,
        confirmed_sections: confirmedSections,
        audit_log: JSON.parse(JSON.stringify(auditLog)),
      };

      const monthlyPayment =
        updateData.current_monthly_rent ??
        lease.current_monthly_rent ??
        lease.monthly_payment ??
        null;
      const termMonths = lease.term_months ?? null;
      const startDate = updateData.lease_start ?? lease.lease_start ?? null;
      const escalationRate = lease.escalation_rate ?? 0;

      if (monthlyPayment && termMonths && startDate && lease.workspace_id) {
        const { calculateLease } = await import('@/lib/leaseCalculations');
        const wsResult = await (supabase as any)
          .from('workspaces')
          .select('discount_rate')
          .eq('id', lease.workspace_id)
          .single();
        const discountRate = wsResult.data?.discount_rate ?? 5.5;
        const calcs = calculateLease({
          monthlyPayment: Number(monthlyPayment),
          termMonths: Number(termMonths),
          startDate,
          escalationRate: Number(escalationRate) || 0,
          discountRate,
        });

        Object.assign(updateData, {
          calc_total_commitment: calcs.totalCashCommitment,
          calc_pv_liability: calcs.pvLiability,
          calc_straight_line_exp: calcs.straightLineExpense,
          calc_cash_pl_delta: calcs.cashPLDelta,
        });
      }

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
        landlord_name:          form.landlord_name          || null,
        tenant_name:            form.tenant_name            || null,
        vendor_name:            form.vendor_name            || null,
        property_address:       form.property_address       || null,
        asset_type:             form.asset_type             || null,
        location:               form.location               || null,
        building:               form.building               || null,
        region:                 form.region                 || null,
        lease_start:            form.lease_start            || null,
        lease_end:              form.lease_end              || null,
        rent_commencement_date: form.rent_commencement_date || null,
        term_months:            form.term_months ? parseInt(form.term_months) || null : null,
        base_rent_amount:       form.base_rent_amount       || null,
        security_deposit:       form.security_deposit       || null,
        renewal_options:        form.renewal_options        || null,
        escalation_clauses:     form.escalation_clauses     || null,
        termination_clauses:    form.termination_clauses    || null,
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
        landlord_name:          form.landlord_name          || null,
        tenant_name:            form.tenant_name            || null,
        vendor_name:            form.vendor_name            || null,
        property_address:       form.property_address       || null,
        asset_type:             form.asset_type             || null,
        location:               form.location               || null,
        building:               form.building               || null,
        region:                 form.region                 || null,
        lease_start:            form.lease_start            || null,
        lease_end:              form.lease_end              || null,
        rent_commencement_date: form.rent_commencement_date || null,
        term_months:            form.term_months ? parseInt(form.term_months) || null : null,
        base_rent_amount:       form.base_rent_amount       || null,
        current_monthly_rent:   form.current_monthly_rent ? parseFloat(form.current_monthly_rent.replace(/[^0-9.]/g, '')) || null : null,
        square_footage:         form.square_footage ? parseFloat(form.square_footage) || null : null,
        security_deposit:       form.security_deposit       || null,
        renewal_options:        form.renewal_options        || null,
        escalation_clauses:     form.escalation_clauses     || null,
        termination_clauses:    form.termination_clauses    || null,
        rent_escalation_type:   form.rent_escalation_type   || null,
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

  // Cancel processing — sets status to Failed so FailedLeaseBanner shows with retry
  const handleCancelProcessing = useCallback(async () => {
    if (!lease || !user) return;
    setCancellingProcessing(true);
    try {
      const { error } = await supabase
        .from('leases')
        .update({ status: 'Failed', error_message: 'Processing cancelled by user' })
        .eq('id', lease.id);
      if (error) throw error;
      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'comment',
        details: { message: 'Processing cancelled by user' },
      });
      setLease((prev: any) => prev ? { ...prev, status: 'Failed', error_message: 'Processing cancelled by user' } : prev);
    } catch (err) {
      console.error('Error cancelling processing:', err);
      toast.error('Failed to cancel processing');
    } finally {
      setCancellingProcessing(false);
    }
  }, [lease, user]);

  const handleUnlockLease = useCallback(async () => {
    if (!lease || !user) return;
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: pendingUnlockRequest?.id
          ? { action: 'approve_unlock_request', unlockRequestId: pendingUnlockRequest.id }
          : { action: 'direct_unlock', leaseId: lease.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.success('Lease unlocked - changes must be submitted for approval');
      refetchLease();
    } catch (err) {
      console.error('Error unlocking lease:', err);
      toast.error('Failed to unlock lease');
    }
  }, [lease, user, pendingUnlockRequest, refetchLease]);

  const handleDenyUnlock = useCallback(async () => {
    if (!lease || !user || !pendingUnlockRequest?.id) return;
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: { action: 'reject_unlock_request', unlockRequestId: pendingUnlockRequest.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.success('Unlock request denied');
      refetchLease();
    } catch (err) {
      console.error('Error denying unlock:', err);
      toast.error('Failed to deny unlock request');
    }
  }, [lease, user, pendingUnlockRequest, refetchLease]);

  const handleSubmitChanges = useCallback(async () => {
    if (!lease || !user || !activeChangeSet?.id) return;
    if (stagedItemCount === 0) { toast.error('No staged changes to submit'); return; }
    setSubmittingChanges(true);
    try {
      const submittedAt = new Date().toISOString();
      const { error } = await (supabase as any)
        .from('lease_change_sets')
        .update({ status: 'pending_approval', submitted_at: submittedAt })
        .eq('id', activeChangeSet.id);
      if (error) throw error;

      // Re-lock the lease NOW. The change_set going to pending_approval
      // means the proposed edits are awaiting financial approval, but the
      // underlying lease fields are still the OLD values and must be
      // protected from further edits during the approval wait. Without this
      // step the lease stayed model_locked=false, the "Locked" detail view
      // never engaged, and the user was stranded in a half-locked workbench
      // with no Save/Cancel/Lock controls visible.
      const { data: relockedRows, error: relockErr } = await (supabase as any)
        .from('leases')
        .update({
          model_locked: true,
          model_locked_at: submittedAt,
          model_locked_by: user.id,
        })
        .eq('id', lease.id)
        .select('id');
      if (relockErr) throw new Error(`Re-lock failed: ${relockErr.message}`);
      if (!relockedRows || relockedRows.length === 0) {
        throw new Error('Re-lock affected 0 rows — likely a permissions issue.');
      }

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'change_submitted',
        details: { change_set_id: activeChangeSet.id, item_count: stagedItemCount, relocked: true },
      });

      // Governance audit — one change_set_submitted row + one field_change_staged per item
      const { data: stagedItems } = await (supabase as any)
        .from('lease_change_set_items')
        .select('field_name, field_label, old_value, proposed_value')
        .eq('change_set_id', activeChangeSet.id);

      const auditRows: any[] = [
        {
          lease_id: lease.id,
          workspace_id: lease.workspace_id,
          event_type: 'change_set_submitted',
          actor_user_id: user.id,
          actor_email: user.email ?? null,
          related_change_set_id: activeChangeSet.id,
          change_summary: `${stagedItemCount} field(s) submitted for approval`,
        },
        ...((stagedItems ?? []) as any[]).map((item: any) => ({
          lease_id: lease.id,
          workspace_id: lease.workspace_id,
          event_type: 'field_change_staged',
          actor_user_id: user.id,
          actor_email: user.email ?? null,
          related_change_set_id: activeChangeSet.id,
          field_name: item.field_name,
          field_label: item.field_label,
          old_value: item.old_value,
          proposed_value: item.proposed_value,
        })),
      ];
      const { error: auditErr3 } = await (supabase as any).from('lease_governance_audit').insert(auditRows);
      if (auditErr3) console.error('[LeaseReview] governance audit error:', auditErr3);

      toast.success('Changes submitted for approval — lease re-locked');
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      refetchLease();
    } catch (err) {
      console.error('Error submitting changes:', err);
      toast.error('Failed to submit changes');
    } finally {
      setSubmittingChanges(false);
    }
  }, [lease, user, activeChangeSet, stagedItemCount, refetchLease]);

  const [isRequestingUnlock, setIsRequestingUnlock] = useState(false);
  const handleRequestUnlock = useCallback(async () => {
    if (!lease || !user) return;
    setIsRequestingUnlock(true);
    try {
      const { data, error } = await supabase.functions.invoke('request-lease-unlock', {
        body: { leaseId: lease.id },
      });
      if (error || !data?.ok) throw new Error(error?.message || data?.error || 'Request failed');
      toast.success('Unlock request sent to your workspace admin');
      refetchLease();
    } catch (err: any) {
      console.error('Error requesting unlock:', err);
      toast.error(err.message ?? 'Failed to send unlock request');
    } finally {
      setIsRequestingUnlock(false);
    }
  }, [lease, user, refetchLease]);

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center font-sans text-muted-foreground">Initializing Cockpit...</div>
    );

  // Show processing indicator
  if (isProcessing) {
    const formatElapsed = (secs: number) => {
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
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
          <p className="text-sm text-muted-foreground mb-1">{lease?.filename}</p>
          {elapsedSeconds > 0 ? (
            <p className="text-xs text-muted-foreground mb-6 flex items-center gap-1.5">
              <Clock className="h-3 w-3" />
              {formatElapsed(elapsedSeconds)} elapsed{elapsedSeconds > 90 ? ' \u00b7 taking longer than usual' : ''}
            </p>
          ) : (
            <div className="mb-6" />
          )}
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => navigate('/app/imports')}>
              View Import History
            </Button>
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              disabled={cancellingProcessing}
              onClick={handleCancelProcessing}
            >
              {cancellingProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <X className="h-4 w-4 mr-2" />}
              Cancel Processing
            </Button>
          </div>
        </div>
      </AppLayout>
    );
  }

  const extractedJson = lease?.extracted_json as ExtractedJson | null;

  // Compute role-aware next-step guidance for the intake stage
  const isRequestor = lease?.requestor_id === user?.id || lease?.user_id === user?.id;
  const isManagerApprover = (userFunctionalRoles ?? []).includes('manager_approver');
  const isFinancialApprover = (userFunctionalRoles ?? []).includes('financial_approver');
  const isAdminUser = userRole === 'admin' || userRole === 'owner';
  const canShareFinancialSummary = Boolean(
    lease?.calc_total_commitment &&
    isAdminUser &&
    ['approved', 'executed', 'active'].includes(lease?.lifecycle_status || ''),
  );

  let nextStepBanner: { type: 'action' | 'info'; message: string } | null = null;
  if (lifecycleStatus === 'submitted') {
    if (isManagerApprover || isAdminUser) {
      nextStepBanner = { type: 'action', message: 'Action required: this request is waiting for your manager review.' };
    } else if (isRequestor) {
      nextStepBanner = { type: 'info', message: "Your request is pending manager review. You'll be notified when the status changes." };
    }
  } else if (lifecycleStatus === 'under_review') {
    if (isFinancialApprover || isAdminUser) {
      nextStepBanner = { type: 'action', message: 'Action required: this request is awaiting your financial review.' };
    } else {
      nextStepBanner = { type: 'info', message: "This request is under financial review. You'll be notified once a decision is made." };
    }
  } else if (lifecycleStatus === 'approved') {
    nextStepBanner = { type: 'info', message: 'This request is approved. Upload the executed document to advance to Executed status.' };
  }

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
                <Button variant="outline" size="sm" onClick={() => navigate('/app/approvals')}>
                  Approval Queue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
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

          {/* Role-aware next-step guidance */}
          {nextStepBanner && (
            <div className={cn(
              'flex items-start gap-3 rounded-lg border p-4',
              nextStepBanner.type === 'action'
                ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-700'
                : 'border-slate-200 bg-slate-50 dark:bg-slate-800/20 dark:border-slate-700'
            )}>
              <ClipboardCheck className={cn(
                'h-5 w-5 mt-0.5 flex-shrink-0',
                nextStepBanner.type === 'action' ? 'text-blue-600' : 'text-slate-400'
              )} />
              <p className={cn(
                'text-sm',
                nextStepBanner.type === 'action'
                  ? 'text-blue-800 dark:text-blue-300 font-medium'
                  : 'text-slate-600 dark:text-slate-400'
              )}>{nextStepBanner.message}</p>
            </div>
          )}

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
            {/* Report Attributes */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2">
                  <CardTitle>Report Attributes</CardTitle>
                  {!editingRequest && !lease.requesting_department && (
                    <button
                      className="text-xs text-amber-600 border border-amber-400 rounded-full px-2 py-0.5 hover:bg-amber-50 transition-colors"
                      onClick={() => {
                        setEditingRequest(true);
                        setTimeout(() => document.getElementById('report-attr-department')?.focus(), 50);
                      }}
                    >
                      + Add Department
                    </button>
                  )}
                </div>
                {!editingRequest && (
                  <Button variant="ghost" size="sm" onClick={() => setEditingRequest(true)}>Edit</Button>
                )}
                {editingRequest && (
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => {
                      setEditingRequest(false);
                      setRequestEdits({
                        request_title: lease.request_title || '',
                        requesting_department: lease.requesting_department || '',
                        vendor_name: lease.vendor_name || '',
                        request_description: lease.request_description || lease.notes || '',
                        asset_type: (lease as any).asset_type || '',
                        region: (lease as any).region || '',
                        location: (lease as any).location || '',
                        building: (lease as any).building || '',
                        vendor_address_line1: (lease as any).vendor_address_line1 || '',
                        vendor_address_line2: (lease as any).vendor_address_line2 || '',
                        vendor_city: (lease as any).vendor_city || '',
                        vendor_state: (lease as any).vendor_state || '',
                        vendor_zip: (lease as any).vendor_zip || '',
                        vendor_phone: (lease as any).vendor_phone || '',
                      });
                    }}>Cancel</Button>
                    <Button size="sm" disabled={savingEdits} onClick={saveRequestEdits}>
                      {savingEdits ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                      Save
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="text-sm">
                {editingRequest ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <Label className="text-xs font-medium text-muted-foreground">Asset Type</Label>
                      <select
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.asset_type}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, asset_type: e.target.value }))}
                      >
                        <option value="">— Select —</option>
                        {assetTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Region</Label>
                      <input
                        list="region-options"
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.region}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, region: e.target.value }))}
                      />
                      <datalist id="region-options">
                        {regionOptions.map((o) => <option key={o} value={o} />)}
                      </datalist>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Location</Label>
                      <input
                        list="location-options"
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.location}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, location: e.target.value }))}
                      />
                      <datalist id="location-options">
                        {locationOptions.map((o) => <option key={o} value={o} />)}
                      </datalist>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Building</Label>
                      <input
                        list="building-options"
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.building}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, building: e.target.value }))}
                      />
                      <datalist id="building-options">
                        {buildingOptions.map((o) => <option key={o} value={o} />)}
                      </datalist>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">Department</Label>
                      <input
                        id="report-attr-department"
                        list="department-options"
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.requesting_department}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, requesting_department: e.target.value }))}
                      />
                      <datalist id="department-options">
                        {departmentOptions.map((o) => <option key={o} value={o} />)}
                      </datalist>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                    <p><span className="font-medium">Asset Type:</span> {(lease as any).asset_type || '\u2014'}</p>
                    <p><span className="font-medium">Region:</span> {(lease as any).region || '\u2014'}</p>
                    <p><span className="font-medium">Location:</span> {(lease as any).location || '\u2014'}</p>
                    <p><span className="font-medium">Building:</span> {(lease as any).building || '\u2014'}</p>
                    <p className="col-span-2"><span className="font-medium">Department:</span> {lease.requesting_department || '\u2014'}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Internal Notes</CardTitle>
                {!editingRequest && (
                  <Button variant="ghost" size="sm" onClick={() => setEditingRequest(true)}>Edit</Button>
                )}
                {editingRequest && (
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => {
                      setEditingRequest(false);
                      setRequestEdits(prev => ({ ...prev, request_description: lease.request_description || (lease as any).notes || '' }));
                    }}>Cancel</Button>
                    <Button size="sm" disabled={savingEdits} onClick={saveRequestEdits}>
                      {savingEdits ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                      Save
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                {editingRequest ? (
                  <textarea
                    rows={4}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    placeholder="Add internal notes..."
                    value={requestEdits.request_description}
                    onChange={(e) => setRequestEdits(prev => ({ ...prev, request_description: e.target.value }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {lease.request_description || (lease as any).notes || '\u2014'}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

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
                      {lease.monthly_payment ? `$${Number(lease.monthly_payment).toLocaleString()}` : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Term</p>
                    <p className="font-medium">{lease.term_months ? `${lease.term_months} months` : '\u2014'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Asset Type</p>
                    <p className="font-medium capitalize">{lease.asset_type || '\u2014'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Escalation Rate</p>
                    <p className="font-medium">
                      {lease.escalation_rate != null ? `${lease.escalation_rate}% / yr` : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Start Date</p>
                    <p className="font-medium">
                      {lease.lease_start ? format(new Date(lease.lease_start), 'MMM d, yyyy') : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">End Date</p>
                    <p className="font-medium">
                      {lease.lease_start && lease.term_months ? (() => {
                        const end = new Date(lease.lease_start);
                        end.setMonth(end.getMonth() + Number(lease.term_months));
                        return format(end, 'MMM d, yyyy');
                      })() : '\u2014'}
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
                            : '\u2014'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Est. Lease Liability (PV)</p>
                        <p className="font-medium">
                          {lease.calc_pv_liability
                            ? `$${Math.round(Number(lease.calc_pv_liability)).toLocaleString()}`
                            : '\u2014'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Monthly P&amp;L Charge</p>
                        <p className="font-medium">
                          {lease.calc_straight_line_exp
                            ? `$${Math.round(Number(lease.calc_straight_line_exp)).toLocaleString()}`
                            : '\u2014'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Cash vs. P&amp;L Delta</p>
                        <p className="font-medium">
                          {lease.calc_cash_pl_delta != null
                            ? `$${Math.round(Number(lease.calc_cash_pl_delta)).toLocaleString()}`
                            : '\u2014'}
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
                          : '\u2014'}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {canShareFinancialSummary && (
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

  // Locked + active leases render the read-only informational layout
  // (sectioned cards, vendor stays editable). All other states fall through
  // to the existing workbench below.
  if (lease?.model_locked === true && lease?.lifecycle_status === 'active') {
    return <LockedLeaseDetail lease={lease} refetchLease={refetchLease} />;
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-muted/30">
        <AppHeader
          title={
            <div className="flex items-center gap-1.5">
              <span>{lease.request_title || lease.property_address || lease.filename || 'Untitled Lease'}</span>
              <button
                onClick={() => { setRenameValue(lease.request_title || ''); setRenameDialogOpen(true); }}
                className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                title="Rename lease"
              >
                <Pencil size={13} />
              </button>
              {lease.lifecycle_status && (
                <LifecycleStatusBadge status={lease.lifecycle_status as any} />
              )}
              {isApproved && (
                <Badge className="bg-green-600 text-white text-xs">
                  <CheckCircle size={12} className="mr-1" />
                  Approved
                </Badge>
              )}
            </div>
          }
          actions={
            <div className="flex items-center gap-2">
              {/* Save Draft / Cancel — only when there's an open draft change set */}
              {!lease.model_locked && activeChangeSet?.status === 'draft' && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toast.success('Draft saved — changes are staged automatically as you type')}
                  >
                    Save Draft
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => setCancelChangeSetDialogOpen(true)}
                    disabled={cancelingChangeSet}
                  >
                    {cancelingChangeSet ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
                    Cancel
                  </Button>
                </>
              )}
              {/* Lock — initial activation OR re-lock with changes */}
              {!lease.model_locked && (lifecycleStatus === 'executed' || lifecycleStatus === 'active') && (
                <Button
                  size="sm"
                  className="bg-success hover:bg-success/90 text-white"
                  onClick={() => setLockConfirmDialogOpen(true)}
                  disabled={
                    submittingChanges ||
                    // Require staged items only when re-locking an active lease with a draft
                    (activeChangeSet?.status === 'draft' && stagedItemCount === 0)
                  }
                >
                  {submittingChanges ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Lock size={14} className="mr-1.5" />}
                  Lock
                </Button>
              )}
              {/* Always-on toolbar — hidden while unlocked for editing so the three edit buttons stand alone on the right */}
              {!(!lease.model_locked && activeChangeSet?.status === 'draft') && (
                <>
                  <Button variant="outline" size="sm" onClick={() => navigate('/app/approvals')}>
                    Approval Queue
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                  <ArchiveButton
                    leaseId={lease.id}
                    isArchived={!!lease.archived}
                    onChange={refetchLease}
                  />
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
                </>
              )}
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

        <div className="flex-1 px-6 overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full rounded-xl border bg-background shadow-sm overflow-hidden"
          >
            {/* Left Panel: PDF Viewer — shown only when lease is editable/in-review */}
            {showPdfPanel && (
              <>
                <ResizablePanel
                  ref={pdfPanelRef}
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
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { pdfPanelRef.current?.collapse(); setIsPdfCollapsed(true); }}>
                        <ChevronLeft size={16} />
                      </Button>
                    </div>
                    <PdfViewer
                      url={pdfUrl}
                      targetPage={targetPage}
                      targetHighlight={targetHighlight}
                      targetValue={targetValue}
                      captureMode={pdfCaptureMode}
                      onCaptureSelection={(page, text) => {
                        setPendingCapture({ page, text });
                        setPdfCaptureMode(false);
                      }}
                    />
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle className="bg-border w-1 hover:bg-primary transition-colors" />
              </>
            )}

            {/* Right Panel: Tabbed Review */}
            <ResizablePanel defaultSize={showPdfPanel ? 50 : 100} minSize={30}>
              <div className="flex h-full flex-col bg-background">

                {/* Global banners */}
                <div className="px-4 pt-3 space-y-2">
                  {showPdfPanel && isPdfCollapsed && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 mb-1"
                      onClick={() => { pdfPanelRef.current?.expand(); setIsPdfCollapsed(false); }}
                    >
                      <ChevronRight size={16} />
                    </Button>
                  )}
                  {isFailedStatus(lease?.status) && (
                    <FailedLeaseBanner
                      leaseId={lease.id}
                      errorMessage={lease.error_message}
                      storagePath={lease.storage_path}
                      onRetrySuccess={() => window.location.reload()}
                    />
                  )}
                  {needsReviewStatus(lease?.lifecycle_status) && (
                    <NeedsReviewBanner
                      landlordName={form.landlord_name}
                      tenantName={form.tenant_name}
                      leaseStart={form.lease_start}
                      leaseEnd={form.lease_end}
                      confidenceScores={confidenceScores}
                    />
                  )}
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
                  {lowConfidenceFields.length > 0 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-400">
                      <AlertTriangle size={10} className="mr-1" />
                      {lowConfidenceFields.length} fields need attention
                    </Badge>
                  )}
                </div>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 overflow-hidden flex flex-col px-4 pt-2">
                  <TabsList className="shrink-0 justify-start">
                    <TabsTrigger value="general">General Information</TabsTrigger>
                    <TabsTrigger value="vendor">Vendor / Counterparty</TabsTrigger>
                    <TabsTrigger value="rent">Rent</TabsTrigger>
                    <TabsTrigger value="options">Options & Clauses</TabsTrigger>
                    <TabsTrigger value="risks">Risks</TabsTrigger>
                    <TabsTrigger value="documents">Documents</TabsTrigger>
                  </TabsList>

                  <ScrollArea className="flex-1 h-full">
                    <div className="py-4 space-y-4 max-w-2xl mx-auto pb-24">

                      {/* General Information */}
                      <TabsContent value="general" className="mt-0 space-y-4">
                        {(['parties', 'property', 'dates'] as SectionKey[]).map((sectionKey) => (
                          <SectionCard
                            key={sectionKey}
                            sectionKey={sectionKey}
                            form={form}
                            extractedJson={extractedJson}
                            confidenceScores={confidenceScores}
                            verifiedFields={verifiedFields}
                            isLocked={isLocked && !isUnlockedForEditing}
                            isModelLocked={!!lease?.model_locked}
                            hideConfidence={lifecycleStatus === 'active'}
                            assetTypes={assetTypes}
                            onFieldChange={handleFieldChange}
                            onFieldFocus={handleFieldFocus}
                            onFieldBlur={trackFieldCorrection}
                            onVerifyField={handleVerifyField}
                            onJumpToPage={jumpToPage}
                            confirmedSections={confirmedSections}
                            onConfirmSection={handleConfirmSection}
                          />
                        ))}
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
                        {/* Amendment Changes */}
                        {isAmendment && extractedJson?._amendment_changes && extractedJson._amendment_changes.length > 0 && (
                          <AmendmentChanges changes={extractedJson._amendment_changes} />
                        )}
                        {/* Executed terms review (executed stage + active staged-editing) */}
                        {(lifecycleStatus === 'executed' || lifecycleStatus === 'active') && (
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
                              changeSetId={activeChangeSet?.status === 'draft' ? activeChangeSet.id : undefined}
                              onStagedCountChange={setStagedItemCount}
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
                            {/* Lock action lives in the AppHeader actions slot
                                (see Save Draft / Cancel / Lock buttons there).
                                The legacy <ModelLockConfirmation> was removed —
                                handleLockAction now handles both initial activation
                                and re-lock-with-changes from one Lock button. */}
                            {lease.model_locked && isAdminUser && pendingUnlockRequest && (
                              <Card className="shadow-none border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
                                <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Unlock requested</p>
                                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                                      A team member has requested to unlock this lease for editing.
                                      {pendingUnlockRequest.request_reason && (
                                        <> Reason: {pendingUnlockRequest.request_reason}.</>
                                      )}
                                      {pendingUnlockRequest.created_at && (
                                        <> Submitted {new Date(pendingUnlockRequest.created_at).toLocaleDateString()}.</>
                                      )}
                                    </p>
                                  </div>
                                  <div className="flex gap-2 shrink-0">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="border-green-500 text-green-700 hover:bg-green-50 dark:text-green-400"
                                      onClick={handleUnlockLease}
                                    >
                                      <RotateCcw size={14} className="mr-1.5" />
                                      Approve & Unlock
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-muted-foreground"
                                      onClick={handleDenyUnlock}
                                    >
                                      Deny
                                    </Button>
                                  </div>
                                </CardContent>
                              </Card>
                            )}
                            {lease.model_locked && isAdminUser && !pendingUnlockRequest && (
                              <Card className="shadow-none border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
                                <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Admin: Unlock for editing</p>
                                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">Unlocking enables staged editing — proposed changes require financial approval before taking effect.</p>
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100 dark:text-amber-300"
                                    onClick={handleUnlockLease}
                                  >
                                    <RotateCcw size={14} className="mr-1.5" />
                                    Unlock
                                  </Button>
                                </CardContent>
                              </Card>
                            )}
                            {lease.model_locked && !isAdminUser && (
                              <Card className="shadow-none border">
                                <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-sm font-medium">Request unlock</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                      {pendingUnlockRequest
                                        ? 'Your unlock request is pending admin approval.'
                                        : 'Ask your workspace admin to unlock this lease for editing.'}
                                    </p>
                                  </div>
                                  {!pendingUnlockRequest && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="shrink-0"
                                      onClick={handleRequestUnlock}
                                      disabled={isRequestingUnlock}
                                    >
                                      {isRequestingUnlock ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <RotateCcw size={14} className="mr-1.5" />}
                                      Request Unlock
                                    </Button>
                                  )}
                                  {pendingUnlockRequest && (
                                    <Badge variant="outline" className="shrink-0">Pending</Badge>
                                  )}
                                </CardContent>
                              </Card>
                            )}
                            {!lease.model_locked && activeChangeSet && (
                              <Card className="shadow-none border border-blue-300 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
                                <CardContent className="py-3 px-4">
                                  <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
                                    {activeChangeSet.status === 'draft'
                                      ? 'Unlocked for editing — changes are staged'
                                      : 'Changes pending approval'}
                                  </p>
                                  <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
                                    {activeChangeSet.status === 'draft'
                                      ? `Edit the executed terms above. ${stagedItemCount} field${stagedItemCount !== 1 ? 's' : ''} staged.`
                                      : 'Your proposed changes have been submitted and are awaiting financial approver review.'}
                                  </p>
                                  {/* Save Draft / Cancel / Lock now live in the AppHeader actions slot. */}
                                </CardContent>
                              </Card>
                            )}
                          </>
                        )}
                      </TabsContent>

                      {/* Vendor / Counterparty */}
                      <TabsContent value="vendor" className="mt-0 space-y-4">
                        <SectionCard
                          sectionKey="vendor"
                          form={form}
                          extractedJson={extractedJson}
                          confidenceScores={confidenceScores}
                          verifiedFields={verifiedFields}
                          isLocked={isLocked && !isUnlockedForEditing}
                          isModelLocked={!!lease?.model_locked}
                          hideConfidence={lifecycleStatus === 'active'}
                          onFieldChange={handleFieldChange}
                          onFieldFocus={handleFieldFocus}
                          onFieldBlur={trackFieldCorrection}
                          onVerifyField={handleVerifyField}
                          onJumpToPage={jumpToPage}
                          confirmedSections={confirmedSections}
                          onConfirmSection={handleConfirmSection}
                        />
                      </TabsContent>

                      {/* Rent */}
                      <TabsContent value="rent" className="mt-0 space-y-4">
                        {(['rent'] as SectionKey[]).map((sectionKey) => (
                          <SectionCard
                            key={sectionKey}
                            sectionKey={sectionKey}
                            form={form}
                            extractedJson={extractedJson}
                            confidenceScores={confidenceScores}
                            verifiedFields={verifiedFields}
                            isLocked={isLocked}
                            isModelLocked={!!lease?.model_locked}
                            hideConfidence={lifecycleStatus === 'active'}
                            onFieldChange={handleFieldChange}
                            onFieldFocus={handleFieldFocus}
                            onFieldBlur={trackFieldCorrection}
                            onVerifyField={handleVerifyField}
                            onJumpToPage={jumpToPage}
                            confirmedSections={confirmedSections}
                            onConfirmSection={handleConfirmSection}
                          />
                        ))}
                        <RentScheduleTable
                          className="shadow-none"
                          rentSchedule={rentSchedule}
                          currentMonthlyRent={derivedInsights.currentRent}
                          rentEscalationType={form.rent_escalation_type || null}
                          isLocked={isLocked || !!lease?.model_locked}
                          onScheduleChange={handleScheduleChange}
                          onGenerateSchedule={handleGenerateSchedule}
                          canGenerate={!!(form.lease_start && form.base_rent_amount)}
                        />
                      </TabsContent>

                      {/* Options & Clauses */}
                      <TabsContent value="options" className="mt-0 space-y-4">
                        {(['options'] as SectionKey[]).map((sectionKey) => (
                          <SectionCard
                            key={sectionKey}
                            sectionKey={sectionKey}
                            form={form}
                            extractedJson={extractedJson}
                            confidenceScores={confidenceScores}
                            verifiedFields={verifiedFields}
                            isLocked={isLocked}
                            isModelLocked={!!lease?.model_locked}
                            hideConfidence={lifecycleStatus === 'active'}
                            onFieldChange={handleFieldChange}
                            onFieldFocus={handleFieldFocus}
                            onFieldBlur={trackFieldCorrection}
                            onVerifyField={handleVerifyField}
                            onJumpToPage={jumpToPage}
                            confirmedSections={confirmedSections}
                            onConfirmSection={handleConfirmSection}
                          />
                        ))}
                      </TabsContent>

                      {/* Risks */}
                      <TabsContent value="risks" className="mt-0 space-y-2">
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            onClick={() => setAddRiskOpen(true)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add Risk
                          </Button>
                        </div>
                        <RisksSection
                          risks={risks}
                          onJumpToPage={jumpToPage}
                          leaseId={lease?.id}
                          onRisksChanged={async () => {
                            const { data } = await supabase
                              .from('risks')
                              .select('*')
                              .eq('lease_id', leaseId)
                              .is('dismissed_at', null);
                            setRisks((data ?? []) as Risk[]);
                          }}
                        />
                      </TabsContent>

                      {/* Documents */}
                      <TabsContent value="documents" className="mt-0 space-y-4">
                        <LeaseDocumentsTab
                          leaseId={lease.id}
                          filename={lease.filename}
                          storagePath={lease.storage_path}
                          executedFilename={lease.executed_filename}
                          executedStoragePath={lease.executed_storage_path}
                          isLocked={!!lease.model_locked}
                        />
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
                      </TabsContent>

                    </div>
                  </ScrollArea>
                </Tabs>

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

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Lease</DialogTitle>
            <DialogDescription>Set a display name for this lease. Leave blank to use the filename.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={lease?.filename || 'Enter a name…'}
            onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>Cancel</Button>
            <Button onClick={saveRename}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Confirmation Dialog */}
      <Dialog open={cancelChangeSetDialogOpen} onOpenChange={setCancelChangeSetDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel changes?</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel? Your changes will not be saved and the lease will lock.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelChangeSetDialogOpen(false)} disabled={cancelingChangeSet}>
              Keep Editing
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelChangeSet}
              disabled={cancelingChangeSet}
            >
              {cancelingChangeSet ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Yes, cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unified Lock Confirmation Dialog — adapts copy by context.
          (a) Re-lock with staged edits: submits change set for approval + re-locks.
          (b) Initial activation: lifecycle → active, model_locked → true. */}
      <Dialog open={lockConfirmDialogOpen} onOpenChange={setLockConfirmDialogOpen}>
        <DialogContent className="sm:max-w-md">
          {(() => {
            const isReLock = activeChangeSet?.status === 'draft' && stagedItemCount > 0;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Lock className="h-5 w-5 text-success" />
                    {isReLock
                      ? `Lock and submit ${stagedItemCount} change${stagedItemCount !== 1 ? 's' : ''}`
                      : 'Lock & activate this lease'}
                  </DialogTitle>
                  <DialogDescription>
                    {isReLock
                      ? 'Your staged changes will be submitted for financial approval. The lease re-locks immediately. Approved changes apply to the live record; rejected ones are reverted.'
                      : 'This action is irreversible. The lease moves to Active status, executed terms freeze, and the record appears in the Active Portfolio dashboard.'}
                  </DialogDescription>
                </DialogHeader>
                {!isReLock && (
                  <ul className="text-xs text-muted-foreground space-y-1 ml-5 list-disc">
                    <li>All executed terms and variance fields are frozen</li>
                    <li>Lease status moves to <strong>Active</strong></li>
                    <li>Record appears in the Active Portfolio dashboard</li>
                    <li>A lock event is written to the activity log</li>
                  </ul>
                )}
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                  {isReLock
                    ? 'This action is irreversible from this screen. To make further edits later, request another unlock.'
                    : 'You can request to unlock the record after activation, but each unlock requires a new approval cycle.'}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setLockConfirmDialogOpen(false)} disabled={submittingChanges}>
                    Cancel
                  </Button>
                  <Button
                    className="bg-success hover:bg-success/90 text-white"
                    onClick={async () => {
                      await handleLockAction();
                      setLockConfirmDialogOpen(false);
                    }}
                    disabled={submittingChanges}
                  >
                    {submittingChanges ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Lock className="h-4 w-4 mr-2" />}
                    {isReLock ? 'Lock & Submit' : 'Lock & Activate'}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Add Risk dialog — coordinates with PdfViewer's capture mode for the
          "Highlight in PDF" citation flow. */}
      {lease?.id && (
        <AddRiskDialog
          open={addRiskOpen}
          onOpenChange={(open) => {
            setAddRiskOpen(open);
            if (!open) setPdfCaptureMode(false);
          }}
          leaseId={lease.id}
          workspaceId={lease.workspace_id ?? null}
          captureActive={pdfCaptureMode}
          pendingCapture={pendingCapture}
          clearPendingCapture={() => setPendingCapture(null)}
          onRequestCapture={() => setPdfCaptureMode(true)}
          onRiskAdded={async () => {
            const { data } = await supabase
              .from('risks')
              .select('*')
              .eq('lease_id', leaseId)
              .is('dismissed_at', null);
            setRisks((data ?? []) as Risk[]);
          }}
        />
      )}
    </AppLayout>
  );
}
