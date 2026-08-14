import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import {
  FileText,
  CheckCircle,
  Check,
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
  MoreHorizontal,
  Archive,
  Download,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsWideViewport } from "@/hooks/use-wide-viewport";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { type ImperativePanelHandle } from "react-resizable-panels";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NudgeApproverButton } from "@/components/workflow/NudgeApproverButton";
import { isFailedStatus } from "@/components/leases/LeaseStatusBadge";
import { localizedAssetTypeName } from "@/lib/assetTypeLabels";
import { NeedsReviewBanner } from "@/components/leases/NeedsReviewBanner";
import { FailedLeaseBanner } from "@/components/leases/FailedLeaseBanner";
import { SectionCard, RisksSection, getFieldConfidence } from "@/components/leases/LeaseReviewSections";
import { SECTION_CONFIG, findFieldLabel, type SectionKey } from "@/lib/leaseReviewSectionConfig";
import { AddRiskDialog, type PendingCitation } from "@/components/leases/AddRiskDialog";
import { Tier2CorrectionDialog } from "@/components/leases/Tier2CorrectionDialog";
import { Asc842InputsTab } from "@/components/leases/Asc842InputsTab";
import { LeaseDiscountRateCard } from "@/components/leases/LeaseDiscountRateCard";
import { ScrollableTabStrip, UNDERLINE_TAB_TRIGGER } from '@/components/ui/scrollable-tabs';
import { downloadCSV } from "@/components/leases/LeaseExports";
import { LeaseReviewStatusStrip } from "@/components/leases/LeaseReviewStatusStrip";
import { useLanguage } from "@/contexts/LanguageContext";
import { formatLocalizedCurrency, formatLocalizedDate } from "@/lib/dateFormatters";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";
import { UploadAmendmentDialog } from "@/components/leases/UploadAmendmentDialog";
import { AmendmentsList } from "@/components/leases/AmendmentsList";
import { AmendmentChanges } from "@/components/leases/AmendmentChanges";
import { PdfViewer } from "@/components/leases/PdfViewer";
import { LifecycleStatusBadge } from "@/components/lifecycle/LifecycleStatusBadge";
import { SummaryShareControls } from '@/components/summary/SummaryShareControls';
import { UploadExecutedDocumentDialog } from "@/components/leases/UploadExecutedDocumentDialog";
import { LeaseDocumentsTab } from "@/components/leases/LeaseDocumentsTab";
import { DocumentsPanel } from "@/components/leases/documents/DocumentsPanel";
import { CounterSignaturePanel } from "@/components/leases/CounterSignaturePanel";
import { ChainViolationBanner } from "@/components/leases/ChainViolationBanner";
import { RerouteHistorySection } from "@/components/leases/RerouteHistorySection";
import { RerouteNotificationModal } from "@/components/leases/RerouteNotificationModal";
import { LockedLeaseDetail } from "@/components/leases/locked/LockedLeaseDetail";
import { ArchiveButton } from "@/components/leases/ArchiveButton";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { retryRequestRouting } from "@/lib/retryRequestRouting";
import { cn } from "@/lib/utils";
import { useApp } from "@/contexts/AppContext";
import { LOW_CONFIDENCE_THRESHOLD, type AuditEntry, type ConfidenceScores } from "@/types/workflow";
import { createLeaseNotification } from '@/lib/leaseNotifications';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';
import { displayLabel, isEquivalent, type LifecycleStatus } from '@/lib/lifecycleStates';
import { localizedStatusLabel } from '@/lib/lifecycleLabels';
import { generateRentScheduleRows } from '@/lib/rentSchedule';
import {
  buildApproverCandidates,
  mergeCandidateIds,
  type ApproverProfile,
} from '@/lib/approverCandidates';
import { classifyRentScheduleDiff } from '@/lib/rentScheduleDiff';
import { isWorkspaceReadOnly } from '@/lib/workspaceReadOnly';

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
  // Tier 2 classification mismatch warnings. Populated by
  // process_lease when Haiku's classification disagrees with the
  // user's selection (lease_type, asset_type). Soft warnings only —
  // do not block submission.
  _tier2_warnings?: string[];
  // Tier 2 Phase 3: candidate parent leases when this upload looks
  // like an amendment. Populated only when the document was
  // declared/detected as an amendment AND there are matches in the
  // workspace by tenant + landlord + property.
  _parent_lease_candidates?: Array<{
    id: string;
    request_title: string | null;
    tenant_name: string | null;
    landlord_name: string | null;
    property_address: string | null;
    lifecycle_status: string | null;
    match_score: number;
    match_reasons: string[];
  }>;
  _approval?: ApprovalMetadata;
  _amendment_changes?: Array<{
    field: string;
    old_value: string | null;
    new_value: string | null;
    change_type?: 'modified' | 'added' | 'removed';
  }>;
}

// Tier-1 required fields that must be marked as reviewed before approval
// Tab is the unit of human attestation. Each tab groups one or more
// sections; the reviewer confirms a whole tab at once via a single
// "Reviewed" affordance at the bottom of the tab content. Internally
// confirmation is still persisted per-section so the data shape doesn't
// change — the UI just lifts the gesture to the tab level.
// NB: `title` holds an i18n key — translate with t(tab.title) at render time.
type ReviewTab = { key: string; title: string; sections: SectionKey[] };
const REVIEW_TABS: ReviewTab[] = [
  { key: 'general', title: 'locked_lease.tabs.general', sections: ['parties', 'property', 'dates'] },
  { key: 'vendor', title: 'locked_lease.vendor.title', sections: ['vendor'] },
  { key: 'rent', title: 'locked_lease.tabs.rent', sections: ['rent'] },
  { key: 'options', title: 'lease_review.tabs.options', sections: ['options'] },
];
const SECTION_TRAVERSAL_ORDER: SectionKey[] = REVIEW_TABS.flatMap((t) => t.sections);
const SECTION_TO_TAB: Record<SectionKey, string> = Object.fromEntries(
  REVIEW_TABS.flatMap((t) => t.sections.map((s) => [s, t.key])),
) as Record<SectionKey, string>;

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

// Same-lease alias routes /app/leases/:id ↔ /app/leases/:id/review render the
// same keyed component (no state loss) — the unsaved-changes guard must never
// prompt when moving between them. The /\/review$/ anchor cannot match
// /financial-review or /signator-review (hyphen, not slash), and navigating to
// THOSE unmounts the workbench, so blocking there is correct.
const isSameLeaseSurface = (a: string, b: string) =>
  a.replace(/\/review$/, '') === b.replace(/\/review$/, '');

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, userRole, userFunctionalRoles, workspace } = useApp();
  // Drives the responsive layout: the side-by-side PDF/form split only renders
  // on wide viewports; below `lg` the workbench is a single full-width column.
  const isWide = useIsWideViewport();
  // Vault (read-only retention) workspaces are view + export only. The server
  // already blocks every write (V1 RLS + config guard); this flag suppresses
  // the mutating UI affordances so a read-only owner sees a clean read-only
  // repository instead of buttons that fail opaquely. Every gate is
  // `&& !isReadOnly`, so live workspaces are unaffected. #136: read-only now
  // covers BOTH the Vault retention tier AND the cancellation grace /
  // soft-delete window (whose plan is still starter/business but whose writes
  // the server RLS rejects) — previously this missed grace users.
  //
  // Wave 5 (honest walls): VIEWER-role members get the same read-only
  // treatment. Before this, the workbench was role-blind — a viewer saw
  // editable fields and an Approve action whose UPDATE the RLS editor gate
  // silently filtered to 0 rows, then a green success toast over a write the
  // database discarded. Riding the Vault plumbing gives viewers the complete,
  // honest read-only experience through every gate below in one place.
  const isViewerRole = userRole === 'viewer';
  const isReadOnly = isWorkspaceReadOnly(workspace) || isViewerRole;
  // The note names the actual cause: workspace state wins over role framing.
  const readOnlyNoteKey = isWorkspaceReadOnly(workspace)
    ? 'readonly.lease_note'
    : 'readonly.viewer_note';
  const [tier2CorrectionOpen, setTier2CorrectionOpen] = useState(false);
  const [showAmendmentDialog, setShowAmendmentDialog] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const queryClient = useQueryClient();
  const { language, t } = useLanguage();
  
  const [lease, setLease] = useState<any | null>(null);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [addRiskOpen, setAddRiskOpen] = useState<boolean>(false);
  const [pdfCaptureMode, setPdfCaptureMode] = useState<boolean>(false);
  const [pendingCapture, setPendingCapture] = useState<PendingCitation | null>(null);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isPdfCollapsed, setIsPdfCollapsed] = useState(false);
  const pdfPanelRef = useRef<ImperativePanelHandle>(null);
  const [targetPage, setTargetPage] = useState<number | undefined>(undefined);
  const [targetHighlight, setTargetHighlight] = useState<string | undefined>(undefined);
  const [targetValue, setTargetValue] = useState<string | undefined>(undefined);
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
  // ASC 842 tab's unsaved-state signal, lifted here via onDirtyChange /
  // onAscDirtyChange — the router supports ONE active blocker, so the page
  // owns the single unsaved-changes guard and children report into it.
  const [ascDirty, setAscDirty] = useState(false);
  // ASC 842 mounts on FIRST activation and then stays mounted (forceMount)
  // — unsaved state survives tab switches without paying its queries on
  // every lease view that never opens the tab.
  const [ascTabTouched, setAscTabTouched] = useState(false);
  useEffect(() => {
    if (activeTab === 'asc842') setAscTabTouched(true);
  }, [activeTab]);
  const [cancelChangeSetDialogOpen, setCancelChangeSetDialogOpen] = useState(false);
  const [lockConfirmDialogOpen, setLockConfirmDialogOpen] = useState(false);
  const [cancelingChangeSet, setCancelingChangeSet] = useState(false);
  // Approver candidates for "Request Approval" flow. Populated when the
  // Lock dialog opens with a draft change_set; combines workspace admins
  // and any explicit workspace_approvers, excludes the current user.
  type ApproverCandidate = { id: string; label: string; isOwner: boolean };
  const [approverCandidates, setApproverCandidates] = useState<ApproverCandidate[]>([]);
  const [selectedApproverId, setSelectedApproverId] = useState<string | null>(null);

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
  const [retryingRouting, setRetryingRouting] = useState(false);
  // C2: the last routing-failure reason, kept on the page (not just a toast) so
  // the person who can fix the policy can read what's wrong without re-triggering.
  const [lastRoutingError, setLastRoutingError] = useState<string | null>(null);

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

  // Per-field confidence (0-100) for the review surfaces (NeedsReviewBanner +
  // the section cards). #114: process_lease never populates
  // leases.confidence_scores, so reading it left this map permanently empty —
  // silently disabling the banner's low-confidence warnings. The real per-field
  // confidence lives in extracted_json (the same source the inline field
  // borders use), so build the map from there via getFieldConfidence (0-1 → 0-100).
  const confidenceScores: ConfidenceScores = useMemo(() => {
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    const scores: ConfidenceScores = {};
    for (const fieldId of allFieldIds) {
      const conf = getFieldConfidence(extractedJson, fieldId);
      if (conf !== null) scores[fieldId] = Math.round(conf * 100);
    }
    return scores;
  }, [lease?.extracted_json, allFieldIds]);

  // Get low-confidence fields
  const lowConfidenceFields = useMemo(() => {
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    return allFieldIds.filter(fieldId => {
      const conf = getFieldConfidence(extractedJson, fieldId);
      return conf !== null && conf < LOW_CONFIDENCE_THRESHOLD / 100;
    });
  }, [lease?.extracted_json, allFieldIds]);

  // Dirty signal — true when in-memory form differs from the last
  // persisted snapshot. Drives (a) the visible "Save draft" secondary
  // button so reviewers can't lose work to a navigate-away, and (b) the
  // page's unsaved-changes guard (SPA navigation + beforeunload) below.
  // savedAt bumps on each successful handleSync; included in deps so
  // the memo re-evaluates after originalValues is repointed.
  const isDirty = useMemo(() => {
    return Object.keys(form).some(
      (k) => (form[k] ?? '') !== (originalValues.current[k] ?? ''),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, savedAt]);

  // One guard instance covers this form AND the ASC 842 tab — the router
  // supports a single active blocker, so the tab lifts its dirty signal here.
  // Also owns the beforeunload twin (the old hand-rolled effect is folded in).
  useUnsavedChangesGuard(isDirty || ascDirty, { isSameSurface: isSameLeaseSurface });

  // Status strip: jump-to-first-flagged-field action. Switches to the tab
  // that surfaces the field's section (module-level SECTION_TO_TAB), then
  // rAF-polls until Radix mounts the tab content (inactive TabsContent is
  // unmounted — same pattern + cap as handleSectionAdvance), scrolls the
  // field row into view, and focuses its control. Focusing an Input/Textarea
  // fires SectionCard's onFocus → marks the field interacted + locates it in
  // the PDF; the explicit setInteractedLowConfFields covers controls that
  // wire no onFocus (the asset-type Select), so repeated clicks step through
  // the remaining flagged fields and the header count drains to reveal
  // Pending Review / Ready to Approve. Marking lives INSIDE the found-branch
  // only — a failed jump never silently consumes a flag.
  const handleJumpToFirstFlagged = useCallback(() => {
    const firstUnreviewed = lowConfidenceFields.find((f) => !interactedLowConfFields.has(f));
    if (!firstUnreviewed) return;
    const sectionForField: Record<string, SectionKey> = {};
    (Object.entries(SECTION_CONFIG) as Array<[SectionKey, typeof SECTION_CONFIG[SectionKey]]>).forEach(([sectionKey, section]) => {
      section.fields.forEach((field) => { sectionForField[field.id] = sectionKey; });
    });
    const sectionKey = sectionForField[firstUnreviewed];
    const targetTab = sectionKey ? SECTION_TO_TAB[sectionKey] : 'general';
    if (targetTab) setActiveTab(targetTab);
    const selector = `[data-field-id="${firstUnreviewed}"]`;
    let attempts = 0;
    const tryJump = () => {
      const el = document.querySelector(selector);
      if (el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 'input, textarea, [role="combobox"]' deliberately excludes 'button'
        // — the per-field "View in document" button precedes the control in
        // DOM order; this selector lands on the real field control.
        el.querySelector<HTMLElement>('input, textarea, [role="combobox"]')?.focus({ preventScroll: true });
        setInteractedLowConfFields((prev) => new Set([...prev, firstUnreviewed]));
        return;
      }
      if (attempts++ < 10) {
        requestAnimationFrame(tryJump);
      }
    };
    requestAnimationFrame(tryJump);
  }, [lowConfidenceFields, interactedLowConfFields]);

  // P1-1: for lifecycle states whose PRIMARY action lives in the Documents tab
  // (negotiation upload/advance/send-back, counter-signature, violation
  // override), land the user there on first load instead of the term-review
  // "General" tab — terms were already confirmed at concept approval, so the
  // documents workbench is the point of the page in these states. Runs once per
  // lease load and never overrides a later manual tab switch.
  const didDefaultDocsTabRef = useRef(false);
  useEffect(() => {
    if (didDefaultDocsTabRef.current) return;
    const s = lease?.lifecycle_status;
    if (!s) return;
    didDefaultDocsTabRef.current = true;
    // Only states whose primary action actually lives in the Documents tab:
    // in_negotiation (upload/advance/send-back), pending_counter_signature
    // (CounterSignaturePanel), chain_violation (ChainViolationBanner). NOT
    // final_review — its primary action is the separate signator-review route,
    // and its Documents tab shows history only (the negotiation buttons gate on
    // lifecycleStatus === 'in_negotiation').
    if (
      s === 'in_negotiation' ||
      s === 'pending_counter_signature' ||
      s === 'chain_violation'
    ) {
      setActiveTab('documents');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lease?.lifecycle_status]);

  // Check approval state from extracted_json
  const approvalState = useMemo(() => {
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    return extractedJson?._approval || null;
  }, [lease?.extracted_json]);
  
  const isApproved = !!approvalState?.approved;

  const lifecycleStatus = lease?.lifecycle_status;
  // Phase 3: bucket chain-vocabulary leases into the same intake / review /
  // posted groups as their legacy equivalents via isEquivalent. 'active'
  // is identical in both vocabularies.
  const lifecycleStatusTyped = lifecycleStatus as LifecycleStatus | undefined;
  // P1-1: 'in_negotiation' shares the post_concept_pre_signator group with
  // legacy 'approved' (STATE_GROUPS), so isEquivalent(..,'approved') is true for
  // it — but it is NOT an intake stage. It's the Phase 4 negotiation phase whose
  // workbench (the Documents tab hosting DocumentsPanel: upload iteration, send
  // back, advance to final review) lives in the main render below. Routing it to
  // the intake early-return made the entire negotiation UI unreachable. Legacy
  // 'approved' (executed-doc upload) legitimately stays on the intake view.
  const isIntakeStage = lifecycleStatusTyped != null &&
    lifecycleStatusTyped !== 'in_negotiation' && (
      isEquivalent(lifecycleStatusTyped, 'submitted') ||
      isEquivalent(lifecycleStatusTyped, 'under_review') ||
      isEquivalent(lifecycleStatusTyped, 'approved')
    );

  // Check status states
  // P1-6: resurrect the nudge. This was hardcoded `false`, so the
  // NudgeApproverButton (its only gate) never rendered — a requestor could never
  // nudge a stalled approver. True when the lease is genuinely WAITING ON AN
  // APPROVER: concept approval (submitted / concept_submitted), concept review
  // (under_review / concept_under_review), or signator review (final_review).
  // NOT in_negotiation (waits on the submitter) or pending_counter_signature
  // (waits on the execution owner) — nudging an approver is meaningless there.
  const isPendingApproval = lifecycleStatusTyped != null && (
    isEquivalent(lifecycleStatusTyped, 'submitted') ||
    isEquivalent(lifecycleStatusTyped, 'under_review') ||
    lifecycleStatusTyped === 'final_review'
  );
  const isProcessing = lease?.status === 'Processing' || lease?.status === 'Uploaded';
  const isPosted = lifecycleStatus === 'active';
  // Lock editing when approved, posted, or pending approval — and always for
  // read-only retention (Vault) workspaces, so every field renders view-only.
  const isLocked = isPosted || isPendingApproval || isApproved || isReadOnly;

  // P1-1: chain post-concept states (negotiation / signature / counter-signature /
  // exception) reach this workbench, but its intake "review the extracted terms →
  // confirm sections → Approve" ceremony does NOT apply to them — the concept was
  // already approved and the forward path lives in the Documents tab (or the
  // signator-review route for final_review). Used to strip the intake-only chrome
  // (header approve/reopen action, the section-progress status strip, the per-tab
  // "Reviewed" footers, and the empty source-PDF split) for these states, so the
  // page reads as a negotiation workbench, not a re-approval screen.
  const isPostConceptChain =
    lifecycleStatus === 'in_negotiation' ||
    lifecycleStatus === 'final_review' ||
    lifecycleStatus === 'pending_counter_signature' ||
    lifecycleStatus === 'chain_violation';
  // Journey fix: 'fully_executed' (the finalize screen) also gets the intake
  // chrome stripped (no confirm-sections status strip, no empty Source-Document
  // split, no per-tab Reviewed footers) — but NOT via isPostConceptChain, which
  // nulls the header primary action; fully_executed KEEPS its "Finalize &
  // activate" button (its own primaryAction branch below).
  const isPostConceptChrome = isPostConceptChain || lifecycleStatus === 'fully_executed';

  // Active lease unlocked for staged editing
  const isUnlockedForEditing = isPosted && !lease?.model_locked && activeChangeSet?.status === 'draft' && !isReadOnly;

  // Show PDF panel alongside tabs when lease is still editable/in-review.
  // Hide it (full-width tabs) when the lease is active and fully locked.
  // The left PDF panel renders only when the lease is editable/in-review AND the
  // viewport is wide enough for a readable two-column split. Below `lg` (or when
  // the lease is locked), this is false → single full-width column, and the
  // source PDF is reached via the Documents tab. Gating here cascades to the
  // panel render, sizing, the collapse control, jumpToPage, and the per-field
  // "View in document" affordance (so it never dead-ends without a panel).
  // P1-1: a chain post-concept lease has no source PDF in the `leases` bucket
  // (its documents live in the Documents-tab timeline / lease_documents), so the
  // left "Source Document" pane would render an empty "PDF unavailable" panel
  // across half the workbench. Suppress the split for those states → full-width
  // tabs; the negotiated documents are reached via the Documents tab.
  const showPdfPanel =
    (lifecycleStatus !== 'active' || !lease?.model_locked) && isWide && !isPostConceptChrome;

  // Approval gate: every AI-extracted section must be marked reviewed.
  // No more field-level "verified" carve-out — sections are the unit of
  // human attestation. This closes the silent-approval gap where a
  // reviewer could approve a lease without ever looking at Vendor,
  // Property, Rent, or Options.
  const allSectionsReviewed = useMemo(
    () => SECTION_TRAVERSAL_ORDER.every((k) => confirmedSections.includes(k)),
    [confirmedSections],
  );

  const canApprove = !isProcessing && allSectionsReviewed && !isReadOnly;

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

      // 1) Save the edited fields (NOT lifecycle/approval columns — those are
      //    trigger-guarded and reset server-side in step 2). calc_* are not
      //    guarded, so persist the recompute here too.
      const { error: saveErr } = await supabase
        .from('leases')
        .update({
          monthly_payment: monthlyPayment,
          term_months: termMonths,
          escalation_rate: escalationRate,
          lease_start: startDate,
          covenant_flagged: resubmitFields.covenantFlagged,
          ...updatedCalcs,
        } as any)
        .eq('id', lease.id);
      if (saveErr) throw saveErr;

      // 2) Server-side: reset the approval columns, recompute the status from the
      //    saved financials, and flip lifecycle — under service role, since a
      //    browser write of those columns is rejected by the governance trigger.
      const { data: resubmitData, error: resubmitError } = await supabase.functions.invoke('legacy-lease-action', {
        body: { action: 'resubmit_request', leaseId: lease.id },
      });
      if (resubmitError) throw new Error(resubmitError.message ?? 'Resubmit failed');
      if ((resubmitData as any)?.error) throw new Error((resubmitData as any).error);
      const newStatus = (resubmitData as any)?.to_status ?? 'submitted';

      toast.success(t('lease_review.toasts.resubmit_success'));
      setResubmitDialogOpen(false);
      setLease((prev: any) => prev ? { ...prev, lifecycle_status: newStatus, financial_returned_to_submitter: false } : prev);
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
    } catch (err) {
      console.error(err);
      toast.error(t('lease_review.toasts.resubmit_failed'));
    } finally {
      setResubmitting(false);
    }
  };

  // Audit C2 — a request-workflow lease whose initial approval routing failed is
  // left in 'draft'. resolve-approval-chain is idempotent on initialResolution,
  // so offer a retry that re-runs the full route → flip → notify orchestration.
  const isFailedRoutingDraft =
    lease?.intake_source === 'request_workflow' && lifecycleStatus === 'draft';

  const handleRetryRouting = async () => {
    if (!lease || !user || !lease.workspace_id) return;
    setRetryingRouting(true);
    try {
      const result = await retryRequestRouting(
        supabase,
        {
          id: lease.id,
          calc_total_commitment: lease.calc_total_commitment ?? null,
          covenant_flagged: lease.covenant_flagged ?? null,
          request_title: lease.request_title ?? null,
        },
        lease.workspace_id,
        user.id,
      );
      if (!result.ok) {
        // NB: this project compiles with strictNullChecks off, so a boolean
        // discriminant (`if (!result.ok)`) does not narrow the union — use the
        // `in` operator, which narrows regardless of strict mode.
        const message = 'errorMessage' in result ? result.errorMessage : t('lease_review.toasts.retry_routing_failed');
        setLastRoutingError(message);
        toast.error(message);
        return;
      }
      const finalStatus = 'finalStatus' in result ? result.finalStatus : undefined;
      setLastRoutingError(null);
      toast.success(t('lease_review.toasts.routed_for_approval'));
      setLease((prev: any) => (prev ? { ...prev, lifecycle_status: finalStatus } : prev));
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
    } catch (err) {
      console.error('Retry routing failed:', err);
      const message = t('lease_review.toasts.retry_routing_failed');
      setLastRoutingError(message);
      toast.error(message);
    } finally {
      setRetryingRouting(false);
    }
  };

  // Cancel (withdraw) a request. The lifecycle flip is trigger-guarded, so it
  // runs SERVER-SIDE via legacy-lease-action (which writes the status_change
  // audit row); the browser cannot set lifecycle_status directly.
  const handleCancelRequest = useCallback(async () => {
    if (!lease) return;
    try {
      const { data, error } = await supabase.functions.invoke('legacy-lease-action', {
        body: { action: 'cancel_request', leaseId: lease.id },
      });
      if (error) throw new Error(error.message ?? t('lease_review.toasts.cancel_request_failed'));
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(t('lease_review.toasts.request_cancelled'));
      setLease((prev: any) => (prev ? { ...prev, lifecycle_status: 'cancelled' } : prev));
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
    } catch (err: any) {
      toast.error(err?.message ?? t('lease_review.toasts.cancel_request_failed'));
    }
  }, [lease, queryClient, t]);

  const saveRequestEdits = useCallback(async () => {
    if (!lease || !user) return;
    setSavingEdits(true);
    try {
      const { data: editRows, error } = await supabase
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
        .eq('id', lease.id)
        // Wave 5: fail on RLS-filtered zero-row writes instead of showing a
        // saved state the database discarded.
        .select('id');

      if (error) throw error;
      if (!editRows || editRows.length === 0) {
        throw new Error(String(t('readonly.write_rejected')));
      }

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
      toast.success(t('lease_review.toasts.report_attributes_updated'));
    } catch (err) {
      console.error('Error saving request edits:', err);
      toast.error(t('lease_review.toasts.save_changes_failed'));
    } finally {
      setSavingEdits(false);
    }
  }, [lease, user, requestEdits, t]);

  const refreshStagedItemCount = useCallback(async () => {
    if (!activeChangeSet?.id) return;
    const { count } = await (supabase as any)
      .from('lease_change_set_items')
      .select('*', { count: 'exact', head: true })
      .eq('change_set_id', activeChangeSet.id);
    setStagedItemCount(count ?? 0);
  }, [activeChangeSet?.id]);

  const stageFieldChange = useCallback(async (changeSetId: string, fieldName: string, fieldLabel: string, oldValue: string | null, newValue: string) => {
    // Treat clear-to-empty as a meaningful edit when there was a value before
    // (someone deliberately blanking a field is information). The dedupe is on
    // "no-op" only.
    if (oldValue === newValue) return;
    const { data, error } = await (supabase as any)
      .from('lease_change_set_items')
      .upsert({
        change_set_id: changeSetId,
        field_name: fieldName,
        field_label: fieldLabel,
        old_value: String(oldValue ?? ''),
        proposed_value: newValue ?? '',
        source_section: 'section_card',
      }, { onConflict: 'change_set_id,field_name' })
      .select('id');
    if (error) {
      console.error('[LeaseReview] stage field error:', error);
      toast.error(t('lease_review.toasts.stage_edit_failed', { fieldLabel, message: error.message ?? t('lease_review.toasts.unknown_error') }));
      return;
    }
    if (!data || data.length === 0) {
      console.warn('[LeaseReview] stage field affected 0 rows — possible RLS issue', { fieldName });
      toast.error(t('lease_review.toasts.stage_edit_no_rows', { fieldLabel }));
      return;
    }
    await refreshStagedItemCount();
  }, [refreshStagedItemCount, t]);


  const saveRename = useCallback(async () => {
    if (!lease) return;
    const trimmed = renameValue.trim();
    const { error } = await supabase
      .from('leases')
      .update({ request_title: trimmed || null })
      .eq('id', lease.id);
    if (error) {
      toast.error(t('lease_review.toasts.rename_failed'));
      return;
    }
    setLease((prev: any) => prev ? { ...prev, request_title: trimmed || null } : prev);
    setRenameDialogOpen(false);
    toast.success(t('lease_review.toasts.rename_success'));
  }, [lease, renameValue, t]);

  const handleStageDocumentUpload = useCallback(async () => {
    if (!lease || !user || !stageFile) {
      toast.error(t('lease_review.toasts.select_pdf_first'));
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
      toast.success(t('lease_review.toasts.document_uploaded'));
    } catch (error) {
      console.error('Error uploading stage document:', error);
      toast.error(t('lease_review.toasts.upload_failed'));
    } finally {
      setUploadingStageFile(false);
    }
  }, [lease, stageFile, user, t]);

  // P1-5: the chain path's missing last step. A counter-signed chain lease sits
  // at 'fully_executed' with no AI abstraction and no route to 'active'. This is
  // the human-triggered "Finalize & activate": process_lease 'finalize' mode
  // abstracts the stored counter-signed document into the primary term columns,
  // recomputes financials, and activates + model-locks the lease. (Replaces the
  // old dead handleRunAbstraction hook, which minted a brand-new lease and was
  // rendered nowhere.)
  const handleFinalize = useCallback(async () => {
    if (!lease) return;
    setRunningAbstraction(true);
    try {
      const formData = new FormData();
      formData.append('extractionMode', 'finalize');
      formData.append('leaseId', lease.id);
      const { data, error } = await supabase.functions.invoke('process_lease', { body: formData });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(t('lease_review.toasts.finalize_success'));
      // Refresh via refetchLease() — this component loads the lease with
      // useEffect+setLease, NOT a ['lease', leaseId] query, so invalidateQueries
      // would be a no-op and the page would stay on the stale fully_executed
      // workbench instead of re-rendering the now-active locked detail. Mirrors
      // handleModelLock. refetchLease is declared below, so it's called in the
      // body but intentionally kept out of the deps array (TDZ).
      refetchLease();
    } catch (error) {
      console.error('Error finalizing lease:', error);
      toast.error(error instanceof Error ? error.message : t('lease_review.toasts.finalize_failed'));
    } finally {
      setRunningAbstraction(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lease, t]);

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

        // The route has no key={leaseId}, so this instance is reused across leases.
        // Clear the per-lease retry-failure message so it can't bleed into another.
        setLastRoutingError(null);
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
  // Load approver candidates whenever the Lock confirm dialog opens with a
  // draft change_set. Sourced from: workspace owner + workspace_members
  // role='admin' + explicit workspace_approvers entries. Self-excluded.
  useEffect(() => {
    if (!lockConfirmDialogOpen) return;
    if (!lease?.workspace_id) return;
    if (!(activeChangeSet?.status === 'draft' && stagedItemCount > 0)) {
      setApproverCandidates([]);
      setSelectedApproverId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Pull the three id sources in parallel.
        const [{ data: ws }, { data: members }, { data: explicit }] = await Promise.all([
          (supabase as any)
            .from('workspaces')
            .select('owner_id')
            .eq('id', lease.workspace_id)
            .maybeSingle(),
          (supabase as any)
            .from('workspace_members')
            .select('user_id, role')
            .eq('workspace_id', lease.workspace_id)
            .eq('role', 'admin'),
          (supabase as any)
            .from('workspace_approvers')
            .select('user_id')
            .eq('workspace_id', lease.workspace_id),
        ]);

        // P2-04 extraction: dedup + self-exclusion + fallback live in
        // src/lib/approverCandidates.ts under unit-test coverage.
        const ownerId = (ws as { owner_id?: string } | null)?.owner_id ?? null;
        const memberAdminIds = ((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
        const explicitApproverIds = ((explicit ?? []) as Array<{ user_id: string }>).map((e) => e.user_id);
        const idArr = mergeCandidateIds({
          ownerId,
          memberAdminIds,
          explicitApproverIds,
          selfId: user?.id ?? null,
        });
        const effectiveIds = idArr.length === 0 && user?.id ? [user.id] : idArr;

        const { data: profiles } = effectiveIds.length
          ? await (supabase as any)
              .from('profiles')
              .select('id, first_name, last_name, email')
              .in('id', effectiveIds)
          : { data: [] };

        const profilesById = new Map<string, ApproverProfile>(
          ((profiles ?? []) as ApproverProfile[]).map((p) => [p.id, p]),
        );

        const candidates = buildApproverCandidates({
          ownerId,
          memberAdminIds,
          explicitApproverIds,
          selfId: user?.id ?? null,
          profilesById,
        });

        if (!cancelled) {
          setApproverCandidates(candidates);
          // Default to the first non-self candidate (owner if present).
          setSelectedApproverId(candidates[0]?.id ?? null);
        }
      } catch (err) {
        console.error('[LeaseReview] failed to load approver candidates:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [lockConfirmDialogOpen, lease?.workspace_id, activeChangeSet?.status, stagedItemCount, user?.id]);

  const handleLockAction = async (mode: 'approver' | 'self_approve' = 'approver', requestedApproverId: string | null = null) => {
    if (!lease) return;
    // Re-lock with staged edits — submit the change_set.
    if (activeChangeSet?.status === 'draft' && stagedItemCount > 0) {
      await handleSubmitChanges(mode, requestedApproverId);
      return;
    }
    // Re-lock with NO staged edits (user unlocked but didn't change anything).
    // Cancel the orphan draft change_set and re-lock in one server call so
    // the lease ends up clean (model_locked=true, no dangling draft).
    if (activeChangeSet?.status === 'draft' && stagedItemCount === 0) {
      setSubmittingChanges(true);
      try {
        const { data, error } = await supabase.functions.invoke('lease-governance-action', {
          body: { action: 'cancel_change_set', changeSetId: activeChangeSet.id },
        });
        if (error) throw new Error(error.message ?? t('lease_review.toasts.lock_failed'));
        if ((data as any)?.error) throw new Error((data as any).error);
        toast.success(t('lease_review.toasts.locked_no_changes'));
        refetchLease();
      } catch (err: any) {
        toast.error(t('lease_review.toasts.lock_failed_with_reason', { message: err?.message ?? t('lease_review.toasts.unknown_error') }));
      } finally {
        setSubmittingChanges(false);
      }
      return;
    }
    setSubmittingChanges(true);
    try {
      // P1-11: model_locked + lifecycle_status are guarded by a DB
      // trigger (migration 20260515010000). The legacy-lease-action
      // edge function performs the transition + audit-log row under
      // service-role credentials.
      const { data, error } = await supabase.functions.invoke('legacy-lease-action', {
        body: { action: 'model_lock', leaseId: lease.id },
      });
      if (error) throw new Error(error.message ?? t('lease_review.toasts.lock_failed'));
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(t('lease_review.toasts.locked_activated'));
      refetchLease();
    } catch (err: any) {
      toast.error(err?.message ?? t('lease_review.toasts.lock_failed'));
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

  /**
   * Direct-stage helper for inputs (e.g. Radix Select on asset_type) that
   * commit-on-change rather than commit-on-blur. Bypasses the form-state
   * read in trackFieldCorrection so there's no closure-staleness race
   * against the just-dispatched setState.
   *
   * Without this, a Select value change would call onFieldChange (which
   * schedules a setState) and then the deferred trackFieldCorrection would
   * read form[fieldId] from a stale closure — staging the OLD value (or
   * skipping the no-op dedupe) and the change would never reach
   * lease_change_set_items. Result: stagedItemCount stayed 0, the Lock
   * dialog showed the empty-draft branch with no admin choice, and on
   * Re-lock the empty draft was discarded.
   */
  const stageFieldImmediate = useCallback(async (fieldId: string, newValue: string) => {
    if (!lease?.id || !isUnlockedForEditing || !activeChangeSet?.id) return;
    const originalValue = originalValues.current[fieldId];
    if (originalValue === newValue) return;
    await stageFieldChange(activeChangeSet.id, fieldId, findFieldLabel(fieldId), originalValue ?? null, newValue);
  }, [lease?.id, isUnlockedForEditing, activeChangeSet?.id, stageFieldChange]);

  // Track field corrections on blur
  const trackFieldCorrection = useCallback(async (fieldId: string) => {
    const originalValue = originalValues.current[fieldId];
    const currentValue = form[fieldId];

    if (originalValue === currentValue || !lease?.id) return;

    // Stage change when unlocked for governance editing
    if (isUnlockedForEditing && activeChangeSet?.id) {
      await stageFieldChange(activeChangeSet.id, fieldId, findFieldLabel(fieldId), originalValue ?? null, currentValue);
    }

    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    const fieldConfidence = getFieldConfidence(extractedJson, fieldId);

    const { error } = await supabase.from('field_corrections').insert({
      lease_id: lease.id,
      field_name: fieldId,
      original_value: originalValue || null,
      corrected_value: currentValue || null,
      ai_confidence: fieldConfidence,
      correction_type: !originalValue ? 'add_missing' : !currentValue ? 'delete_wrong' : 'edit'
    });
    if (error) {
      // #85: this is a background analytics write (no user-facing toast), but it
      // must not drop silently — surface to logs and DON'T advance the tracked
      // baseline, so the next field change re-attempts rather than losing the
      // correction.
      console.error('Failed to record field correction:', error);
      return;
    }

    originalValues.current[fieldId] = currentValue;
  }, [form, lease?.id, lease?.extracted_json, isUnlockedForEditing, activeChangeSet?.id, stageFieldChange]);

  // Flush any dirty-but-unblurred edits into the change set BEFORE opening the
  // finalize dialog, so stagedItemCount reflects every change. Without this, a
  // field that was typed but not blurred races the dialog open: the empty-draft
  // branch could fire and cancel_change_set would silently discard the edit
  // (integrity HIGH). Uses the same null/'' normalization as isDirty so
  // untouched empty fields are never spuriously staged.
  const flushStagedEdits = useCallback(async () => {
    if (!isUnlockedForEditing || !activeChangeSet?.id) return;
    const dirty = Object.keys(form).filter(
      (k) => (form[k] ?? '') !== (originalValues.current[k] ?? ''),
    );
    for (const fieldId of dirty) {
      await stageFieldImmediate(fieldId, form[fieldId]);
    }
    await refreshStagedItemCount();
  }, [isUnlockedForEditing, activeChangeSet?.id, form, stageFieldImmediate, refreshStagedItemCount]);

  // Track low-confidence field focus
  const handleFieldFocus = useCallback((fieldId: string) => {
    const extractedJson = lease?.extracted_json as ExtractedJson | null;
    const conf = getFieldConfidence(extractedJson, fieldId);
    if (conf !== null && conf < LOW_CONFIDENCE_THRESHOLD / 100) {
      setInteractedLowConfFields(prev => new Set([...prev, fieldId]));
    }
  }, [lease?.extracted_json]);

  // Toggle a section's reviewed state. Persists. Toggle semantics so a
  // user can correct a wrong confirmation by clicking the green pill.
  const handleConfirmSection = useCallback(async (sectionKey: string) => {
    const isAlready = confirmedSections.includes(sectionKey);
    const newConfirmed = isAlready
      ? confirmedSections.filter((k) => k !== sectionKey)
      : [...confirmedSections, sectionKey];
    const prevConfirmed = confirmedSections;
    setConfirmedSections(newConfirmed);
    if (lease?.id) {
      // Wave 5: .select() so an RLS-filtered write (0 rows, no error) also
      // reverts — PostgREST reports success on zero-row updates.
      const { data: savedRows, error } = await supabase
        .from('leases')
        .update({ confirmed_sections: newConfirmed })
        .eq('id', lease.id)
        .select('id');
      if (error || !savedRows || savedRows.length === 0) {
        // #85: the write was rejected (e.g. Vault/grace read-only RLS) — revert
        // the optimistic state instead of leaving the UI claiming a saved review.
        setConfirmedSections(prevConfirmed);
        toast.error(String(t('lease_review.strip.save_review_failed')));
      }
    }
  }, [confirmedSections, lease?.id]);

  // Compute the next unconfirmed section in traversal order, given the
  // section the user just confirmed. Returns null if none remains.
  const nextUnconfirmedAfter = useCallback(
    (currentKey: SectionKey, justConfirmed?: SectionKey): SectionKey | null => {
      const confirmedSet = new Set(confirmedSections);
      if (justConfirmed) confirmedSet.add(justConfirmed);
      const currentIdx = SECTION_TRAVERSAL_ORDER.indexOf(currentKey);
      // Look forward first
      for (let i = currentIdx + 1; i < SECTION_TRAVERSAL_ORDER.length; i++) {
        if (!confirmedSet.has(SECTION_TRAVERSAL_ORDER[i])) return SECTION_TRAVERSAL_ORDER[i];
      }
      // Then wrap around to find any earlier unconfirmed section.
      for (let i = 0; i < currentIdx; i++) {
        if (!confirmedSet.has(SECTION_TRAVERSAL_ORDER[i])) return SECTION_TRAVERSAL_ORDER[i];
      }
      return null;
    },
    [confirmedSections],
  );

  // Advance: switch tab if needed, scroll the target section's header
  // into view. Radix Tabs unmounts inactive TabsContent so the target
  // anchor doesn't exist at setActiveTab call time — a fixed timeout
  // races against React commit + Radix transition. We poll across a
  // handful of animation frames (cap ~10 = ~160ms at 60fps) until the
  // anchor mounts, then scroll. Stops cleanly if the user navigated
  // away in the meantime.
  const handleSectionAdvance = useCallback((targetKey: SectionKey) => {
    const targetTab = SECTION_TO_TAB[targetKey];
    if (targetTab) setActiveTab(targetTab);
    const selector = `[data-section-key="${targetKey}"]`;
    let attempts = 0;
    const tryScroll = () => {
      const el = document.querySelector(selector);
      if (el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (attempts++ < 10) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, []);

  // Combined: confirm the current section AND advance to the next
  // unconfirmed one. Used by the section footer's primary button when
  // the section is not yet confirmed.
  const handleConfirmAndAdvance = useCallback(async (sectionKey: SectionKey) => {
    if (!confirmedSections.includes(sectionKey)) {
      const prevConfirmed = confirmedSections;
      const newConfirmed = [...confirmedSections, sectionKey];
      setConfirmedSections(newConfirmed);
      if (lease?.id) {
        const { error } = await supabase
          .from('leases')
          .update({ confirmed_sections: newConfirmed })
          .eq('id', lease.id);
        if (error) {
          // #85: revert the optimistic confirm and surface; don't advance to
          // the next section when the save was rejected.
          setConfirmedSections(prevConfirmed);
          toast.error(String(t('lease_review.strip.save_review_failed')));
          return;
        }
      }
    }
    const next = nextUnconfirmedAfter(sectionKey, sectionKey);
    if (next) handleSectionAdvance(next);
  }, [confirmedSections, lease?.id, nextUnconfirmedAfter, handleSectionAdvance]);

  // Tab-level helpers — the user-facing unit of attestation. A tab is
  // confirmed iff every section it contains is confirmed.
  const isTabConfirmed = useCallback(
    (tabKey: string) => {
      const tab = REVIEW_TABS.find((t) => t.key === tabKey);
      if (!tab) return false;
      return tab.sections.every((s) => confirmedSections.includes(s));
    },
    [confirmedSections],
  );

  const confirmedTabsCount = useMemo(
    () => REVIEW_TABS.filter((t) => t.sections.every((s) => confirmedSections.includes(s))).length,
    [confirmedSections],
  );

  const remainingTabTitles = useMemo(
    () => REVIEW_TABS
      .filter((tab) => !tab.sections.every((s) => confirmedSections.includes(s)))
      .map((tab) => t(tab.title)),
    [confirmedSections, t],
  );

  // Toggle every section in a tab. Confirming a tab marks all its
  // sections at once; unmarking does the inverse. Unmarking a tab
  // while the lease is approved is the user's explicit "I want to
  // change something" signal — we revert the approval in the same DB
  // write so fields re-open for editing and the header primary action
  // flips back from Lock Lease to Pending Review. Confirming auto-
  // advances to the next unconfirmed tab.
  const handleConfirmTab = useCallback(async (tabKey: string) => {
    const tab = REVIEW_TABS.find((t) => t.key === tabKey);
    if (!tab) return;
    const allIn = tab.sections.every((s) => confirmedSections.includes(s));
    const newConfirmed = allIn
      ? confirmedSections.filter((s) => !tab.sections.includes(s as SectionKey))
      : Array.from(new Set([...confirmedSections, ...tab.sections]));
    const prevConfirmed = confirmedSections;
    setConfirmedSections(newConfirmed);

    // Unmark while approved → revert approval in the same update.
    const shouldRevertApproval = allIn && isApproved;
    const prevExtractedJson = lease?.extracted_json;
    const updatePayload: Record<string, any> = { confirmed_sections: newConfirmed };
    if (shouldRevertApproval) {
      const currentExtractedJson = (lease?.extracted_json || {}) as ExtractedJson;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _approval, ...rest } = currentExtractedJson;
      updatePayload.extracted_json = rest;
      setLease((prev: any) => prev ? { ...prev, extracted_json: rest } : prev);
    }
    if (lease?.id) {
      const { error } = await supabase.from('leases').update(updatePayload).eq('id', lease.id);
      if (error) {
        // #85: revert BOTH optimistic updates (confirm state + the approval-strip
        // mutation) and surface, instead of showing "Tab reopened" over a write
        // the DB rejected (e.g. Vault/grace read-only RLS).
        setConfirmedSections(prevConfirmed);
        if (shouldRevertApproval) {
          setLease((prev: any) => prev ? { ...prev, extracted_json: prevExtractedJson } : prev);
        }
        toast.error(String(t('lease_review.strip.save_review_failed')));
        return;
      }
    }
    if (shouldRevertApproval) {
      toast.message(t('lease_review.toasts.tab_reopened'));
    }

    if (!allIn) {
      const nextTab = REVIEW_TABS.find(
        (t) => t.key !== tabKey && !t.sections.every((s) => newConfirmed.includes(s)),
      );
      if (nextTab) {
        setActiveTab(nextTab.key);
        // Reuse the same retry-loop pattern to scroll the first
        // section into view once the tab content mounts.
        const selector = `[data-section-key="${nextTab.sections[0]}"]`;
        let attempts = 0;
        const tryScroll = () => {
          const el = document.querySelector(selector);
          if (el) {
            (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
          if (attempts++ < 10) requestAnimationFrame(tryScroll);
        };
        requestAnimationFrame(tryScroll);
      }
    }
  }, [confirmedSections, lease?.id]);

  const handleAdvanceTab = useCallback((targetTabKey: string) => {
    const tab = REVIEW_TABS.find((t) => t.key === targetTabKey);
    if (!tab) return;
    setActiveTab(targetTabKey);
    const selector = `[data-section-key="${tab.sections[0]}"]`;
    let attempts = 0;
    const tryScroll = () => {
      const el = document.querySelector(selector);
      if (el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (attempts++ < 10) requestAnimationFrame(tryScroll);
    };
    requestAnimationFrame(tryScroll);
  }, []);

  // All sections gate approval now. Titles surface to the strip.
  const requiredSectionTitles = useMemo(
    () => SECTION_TRAVERSAL_ORDER.map((k) => SECTION_CONFIG[k].title),
    [],
  );
  const remainingSectionTitles = useMemo(
    () => SECTION_TRAVERSAL_ORDER
      .filter((k) => !confirmedSections.includes(k))
      .map((k) => SECTION_CONFIG[k].title),
    [confirmedSections],
  );
  const confirmedSectionCount = SECTION_TRAVERSAL_ORDER.filter((k) => confirmedSections.includes(k)).length;

  // Bulk: mark every required section reviewed in one click. Toasts the
  // sections that were newly added so the user sees what changed.
  const handleConfirmAllRequired = useCallback(async () => {
    const newlyAdded = SECTION_TRAVERSAL_ORDER.filter((k) => !confirmedSections.includes(k));
    if (newlyAdded.length === 0) return;
    const prevConfirmed = confirmedSections;
    const merged = [...confirmedSections, ...newlyAdded];
    setConfirmedSections(merged);
    const newlyAddedTitles = newlyAdded.map((k) => SECTION_CONFIG[k].title);
    const formatter = (() => {
      const LF = (Intl as unknown as { ListFormat?: new (locale: string, opts: { style: string; type: string }) => { format(items: string[]): string } }).ListFormat;
      if (LF) {
        try {
          return new LF(language === 'es' ? 'es' : 'en', { style: 'long', type: 'conjunction' }).format(newlyAddedTitles);
        } catch {
          /* fall through to join */
        }
      }
      return newlyAddedTitles.join(', ');
    })();
    if (lease?.id) {
      const { error } = await supabase
        .from('leases')
        .update({ confirmed_sections: merged })
        .eq('id', lease.id);
      if (error) {
        // #85: revert + surface; the success toast must follow a confirmed
        // write, not precede an unchecked one.
        setConfirmedSections(prevConfirmed);
        toast.error(String(t('lease_review.strip.save_review_failed')));
        return;
      }
    }
    toast.success(String(t('lease_review.strip.marked_reviewed_toast', { sections: formatter })));
  }, [confirmedSections, lease?.id]);

  // Rent schedule: persist inline edits
  const handleScheduleChange = useCallback(async (updated: RentScheduleEntry[]) => {
    setRentSchedule(updated);
    if (!leaseId) return;

    // P2-04 extraction: classify into delete/insert/update under unit-test
    // coverage. This handler owns only the supabase calls.
    const diff = classifyRentScheduleDiff(rentSchedule, updated);

    if (diff.deleteIds.length > 0) {
      await supabase.from('rent_schedules').delete().in('id', diff.deleteIds);
    }
    for (const row of diff.inserts) {
      const { id: _id, ...rest } = row;
      await supabase.from('rent_schedules').insert({ ...rest, lease_id: leaseId });
    }
    for (const row of diff.updates) {
      await supabase.from('rent_schedules').update({
        period_start: row.period_start,
        period_end: row.period_end,
        monthly_amount: row.monthly_amount,
        annual_amount: row.annual_amount,
        notes: row.notes,
      }).eq('id', row.id);
    }
    // Re-fetch to get server-assigned IDs for new rows
    const { data } = await supabase.from('rent_schedules').select('*').eq('lease_id', leaseId).order('period_start');
    if (data) setRentSchedule(data);
  }, [leaseId, rentSchedule]);

  // Rent schedule: auto-generate
  const handleGenerateSchedule = useCallback(async (mode: 'single' | 'annual') => {
    if (!leaseId || !form.lease_start || !form.base_rent_amount) return;
    const baseRent = parseFloat(form.base_rent_amount.replace(/[^0-9.]/g, '')) || 0;
    const escalationRate = lease?.escalation_rate ? Number(lease.escalation_rate) / 100 : 0;

    // P2-04 extraction: rent + escalation math now lives in
    // src/lib/rentSchedule.ts under unit-test coverage. This handler
    // owns input parsing, error toasts, and the DB write.
    const result = generateRentScheduleRows({
      leaseId,
      baseRent,
      startDate: form.lease_start,
      endDate: form.lease_end || null,
      escalationRate,
      mode,
    });

    if (result.ok === false) {
      if (result.reason === 'invalid_base_rent') {
        toast.error(t('lease_review.toasts.base_rent_required'));
      } else if (result.reason === 'missing_escalation_rate') {
        toast.error(t('lease_review.toasts.escalation_rate_required'));
      }
      return;
    }

    const { error } = await supabase.from('rent_schedules').insert(result.rows as any);
    if (error) { toast.error(t('lease_review.toasts.generate_schedule_failed')); return; }
    const { data } = await supabase.from('rent_schedules').select('*').eq('lease_id', leaseId).order('period_start');
    if (data) setRentSchedule(data);
    toast.success(t('lease_review.toasts.schedule_generated'));
  }, [leaseId, form.lease_start, form.lease_end, form.base_rent_amount, lease?.escalation_rate, t]);

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
      toast.success(t('lease_review.toasts.changes_discarded'));
      refetchLease();
    } catch (err) {
      console.error('Error canceling change set:', err);
      toast.error(t('lease_review.toasts.discard_failed'));
    } finally {
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      setCancelingChangeSet(false);
    }
  }, [lease, user, activeChangeSet, refetchLease, t]);

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
      // Mark current form as the new persisted snapshot so isDirty
      // returns to false (hides the visible "Save draft" button).
      originalValues.current = { ...form };
      setSavedAt((n) => n + 1);
      toast.success(t('lease_review.toasts.lease_saved'));
    } catch (err) {
      toast.error(t('lease_review.toasts.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  // Approve lease - stores approval in extracted_json._approval
  const handleApproveLease = async () => {
    if (!allSectionsReviewed) {
      toast.error(t('lease_review.toasts.review_all_before_approve'));
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

      // Wave 5: .select() so an RLS-filtered write (0 rows) FAILS instead of
      // masquerading as success — the "green toast over a discarded approval"
      // silent lie from the Wave-4 persona sweep. Belt-and-suspenders under the
      // viewer read-only gate above.
      const { data: approvedRows, error } = await supabase
        .from("leases")
        .update(updateData)
        .eq("id", lease.id)
        .select("id");

      if (error) throw error;
      if (!approvedRows || approvedRows.length === 0) {
        throw new Error(String(t('readonly.write_rejected')));
      }

      // Mirror the approval into the canonical audit log (previously only
      // persisted inside extracted_json._approval, which is overwritable by
      // re-extraction). Best-effort — the approve itself already succeeded.
      const { error: logError } = await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user?.id ?? null,
        activity_type: 'approval',
        details: {
          routing_path: 'legacy',
          triggered_by: 'lease_review_approve',
          approved_at: approvalMetadata.approved_at,
        },
      });
      if (logError) console.error('[handleApproveLease] activity log error:', logError.message);

      // Update local state
      setLease((prev: any) => ({
        ...prev,
        extracted_json: updateData.extracted_json,
      }));

      toast.success(t('lease_review.toasts.approve_success'));
    } catch (err) {
      console.error('Error approving lease:', err);
      toast.error(t('lease_review.toasts.approve_failed'));
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
      
      toast.success(t('lease_review.toasts.reopen_success'));
    } catch (err) {
      console.error('Error reopening lease:', err);
      toast.error(t('lease_review.toasts.reopen_failed'));
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
      toast.error(t('lease_review.toasts.cancel_processing_failed'));
    } finally {
      setCancellingProcessing(false);
    }
  }, [lease, user, t]);

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

      toast.success(t('lease_review.toasts.unlock_success'));
      refetchLease();
    } catch (err) {
      console.error('Error unlocking lease:', err);
      toast.error(t('lease_review.toasts.unlock_failed'));
    }
  }, [lease, user, pendingUnlockRequest, refetchLease, t]);

  const handleDenyUnlock = useCallback(async () => {
    if (!lease || !user || !pendingUnlockRequest?.id) return;
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: { action: 'reject_unlock_request', unlockRequestId: pendingUnlockRequest.id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);

      toast.success(t('lease_review.toasts.unlock_denied'));
      refetchLease();
    } catch (err) {
      console.error('Error denying unlock:', err);
      toast.error(t('lease_review.toasts.deny_unlock_failed'));
    }
  }, [lease, user, pendingUnlockRequest, refetchLease, t]);

  /**
   * Lock-with-edits: routes the staged change_set through the centralized
   * `lease-governance-action` edge function. Two modes:
   *   - 'approver'      → standard pending_approval queue (any role).
   *   - 'self_approve'  → admin-only soft bypass: changes apply immediately,
   *                        change_set marked self_approved=true with full
   *                        audit trail (auditors filter on this column).
   * The frontend selects the mode based on userRole + the user's choice in
   * the Lock confirm dialog. The edge function re-validates on the server
   * — that's the trust boundary, the frontend role check is UX only.
   */
  const handleSubmitChanges = useCallback(async (mode: 'approver' | 'self_approve' = 'approver', requestedApproverId: string | null = null) => {
    if (!lease || !user || !activeChangeSet?.id) return;
    if (stagedItemCount === 0) { toast.error(t('lease_review.toasts.no_changes_to_submit')); return; }
    setSubmittingChanges(true);
    try {
      const { data, error } = await supabase.functions.invoke('lease-governance-action', {
        body: {
          action: 'submit_change_set',
          changeSetId: activeChangeSet.id,
          mode,
          requestedApproverId: mode === 'approver' ? requestedApproverId : null,
        },
      });
      if (error) throw new Error(error.message ?? t('lease_review.toasts.submit_failed'));
      if ((data as any)?.error) throw new Error((data as any).error);
      if (mode === 'self_approve') {
        toast.success(t('lease_review.toasts.changes_self_approved'));
      } else {
        toast.success(t('lease_review.toasts.changes_submitted'));
      }
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });
      refetchLease();
    } catch (err: any) {
      console.error('Error submitting changes:', err);
      toast.error(t('lease_review.toasts.submit_changes_failed', { message: err?.message ?? t('lease_review.toasts.unknown_error') }));
    } finally {
      setSubmittingChanges(false);
    }
  }, [lease, user, activeChangeSet, stagedItemCount, refetchLease, queryClient, t]);

  const [isRequestingUnlock, setIsRequestingUnlock] = useState(false);
  const handleRequestUnlock = useCallback(async () => {
    if (!lease || !user) return;
    setIsRequestingUnlock(true);
    try {
      const { data, error } = await supabase.functions.invoke('request-lease-unlock', {
        body: { leaseId: lease.id },
      });
      if (error || !data?.ok) throw new Error(error?.message || data?.error || t('lease_review.toasts.unlock_request_failed'));
      toast.success(t('lease_review.toasts.unlock_request_sent'));
      refetchLease();
    } catch (err: any) {
      console.error('Error requesting unlock:', err);
      toast.error(err.message ?? t('lease_review.toasts.unlock_request_failed'));
    } finally {
      setIsRequestingUnlock(false);
    }
  }, [lease, user, refetchLease, t]);

  // #116: honor the ?action=archive deep-link from ImportHistory's Archive
  // steer. A committed lease can't be hard-deleted there; the steer opens the
  // lease here with the archive dialog already up so it's one gesture, not a
  // scavenger hunt through the ⋯ menu. This handles the non-locked workbench
  // path; the locked-active path (early-returned to LockedLeaseDetail below) is
  // handled in LockedHeader. Gated to admin/owner (only they can archive) and
  // self-stripping so a refresh doesn't re-trigger.
  // NB: must live ABOVE the `if (loading)` / `if (isProcessing)` early returns —
  // a hook called after a conditional return violates the rules of hooks (#133).
  // The body self-guards (it no-ops until `lease` loads), so the early position
  // is harmless.
  useEffect(() => {
    if (searchParams.get('action') !== 'archive') return;
    const lockedActive = lease?.model_locked === true && lease?.lifecycle_status === 'active';
    if (lockedActive) return;
    const isAdmin = userRole === 'admin' || userRole === 'owner';
    if (!lease || lease.archived || isReadOnly || !isAdmin) return;
    setShowArchiveDialog(true);
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [searchParams, lease, isReadOnly, userRole, setSearchParams]);

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center font-sans text-muted-foreground">{t('lease_review.processing.initializing')}</div>
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
          <h2 className="text-2xl font-semibold mb-2">{t('lease_review.processing.title')}</h2>
          <p className="text-muted-foreground text-center max-w-md mb-2">
            {t('lease_review.processing.description')}
          </p>
          <p className="text-sm text-muted-foreground mb-1">{lease?.filename}</p>
          {elapsedSeconds > 0 ? (
            <p className="text-xs text-muted-foreground mb-6 flex items-center gap-1.5">
              <Clock className="h-3 w-3" />
              {t('lease_review.processing.elapsed', { time: formatElapsed(elapsedSeconds) })}{elapsedSeconds > 90 ? t('lease_review.processing.taking_longer') : ''}
            </p>
          ) : (
            <div className="mb-6" />
          )}
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => navigate('/app/imports')}>
              {t('lease_review.processing.view_import_history')}
            </Button>
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              disabled={cancellingProcessing}
              onClick={handleCancelProcessing}
            >
              {cancellingProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <X className="h-4 w-4 mr-2" />}
              {t('lease_review.processing.cancel_processing')}
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

  // Phase 3: include chain post_concept_pre_signator + signator stages +
  // executed equivalent (active is identical in both vocabularies).
  const canShareFinancialSummary = Boolean(
    lease?.calc_total_commitment &&
    isAdminUser &&
    !isReadOnly &&  // Vault read-only: minting a share link is a write that 403s server-side (audit D2)
    [
      'approved', 'executed', 'active',
      'in_negotiation', 'final_review', 'pending_counter_signature', 'fully_executed',
    ].includes(lease?.lifecycle_status || ''),
  );

  // Phase 3: branch via isEquivalent so chain-vocabulary leases
  // (concept_submitted / concept_under_review / in_negotiation) surface
  // the same banners as their legacy equivalents.
  const lifecycle = lifecycleStatus as LifecycleStatus;
  let nextStepBanner: { type: 'action' | 'info'; message: string } | null = null;
  if (isEquivalent(lifecycle, 'submitted')) {
    if (isManagerApprover || isAdminUser) {
      nextStepBanner = { type: 'action', message: t('lease_review.banners.manager_action_required') };
    } else if (isRequestor) {
      nextStepBanner = { type: 'info', message: t('lease_review.banners.pending_manager_review') };
    }
  } else if (isEquivalent(lifecycle, 'under_review')) {
    if (isFinancialApprover || isAdminUser) {
      nextStepBanner = { type: 'action', message: t('lease_review.banners.financial_action_required') };
    } else {
      nextStepBanner = { type: 'info', message: t('lease_review.banners.under_financial_review') };
    }
  } else if (isEquivalent(lifecycle, 'approved')) {
    nextStepBanner = { type: 'info', message: t('lease_review.banners.approved_next_step') };
  }

  // C2 — failed-routing draft: a focused page with a retry, instead of the
  // (mostly-empty, confusing) review workbench. Once routing succeeds the lease
  // flips out of 'draft' and re-renders as the intake-stage page below.
  if (isFailedRoutingDraft && lease) {
    return (
      <AppLayout>
        <div className="max-w-3xl mx-auto p-6 space-y-4">
          <AppHeader
            title={lease.request_title || t('lease_review.intake.lease_request_fallback')}
            subtitle={
              <div className="flex items-center gap-2">
                <LifecycleStatusBadge status={lease.lifecycle_status as any} />
                <span className="text-sm text-muted-foreground">{lease.requesting_department || t('lease_review.intake.unknown_department')}</span>
              </div>
            }
            actions={
              <Button variant="outline" size="sm" onClick={() => navigate('/app/approvals')}>
                {t('lease_review.intake.approval_queue')}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            }
          />
          <Card className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/10 dark:border-amber-800">
            <CardContent className="py-5 space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">{t('routing_failed.title')}</p>
                  <p className="text-sm text-muted-foreground">{t('routing_failed.body')}</p>
                  {lastRoutingError ? (
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-400 pt-1">
                      {t('routing_failed.last_error', { message: lastRoutingError })}
                    </p>
                  ) : null}
                </div>
              </div>
              {isReadOnly ? (
                <p className="text-sm text-muted-foreground pl-8">{t(readOnlyNoteKey)}</p>
              ) : isRequestor || isAdminUser ? (
                <div className="flex items-center gap-3 pl-8">
                  <Button onClick={handleRetryRouting} disabled={retryingRouting}>
                    {retryingRouting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                    {t('routing_failed.retry')}
                  </Button>
                  <span className="text-xs text-muted-foreground">{t('routing_failed.admin_hint')}</span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground pl-8">{t('routing_failed.cannot_retry')}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  if (isIntakeStage && lease) {
    return (
      <AppLayout>
        <div className="p-6 space-y-4">
          <AppHeader
            title={lease.request_title || t('lease_review.intake.lease_request_fallback')}
            subtitle={
              <div className="flex items-center gap-2">
                <LifecycleStatusBadge status={lease.lifecycle_status as any} />
                <span className="text-sm text-muted-foreground">{lease.requesting_department || t('lease_review.intake.unknown_department')}</span>
              </div>
            }
            actions={
              <div className="flex items-center gap-2">
                {/* P1-6: the nudge, finally reachable. A requestor (or admin) can
                    nudge the current pending approver when their request is
                    waiting — this intake view is where they actually see the
                    stalled request. send-nudge resolves the live approver + the
                    server-side cooldown. */}
                {isPendingApproval && (isRequestor || isAdminUser) && !isReadOnly && (
                  <NudgeApproverButton leaseId={lease.id} lastNudgedAt={lease.last_nudged_at} />
                )}
                <Button variant="outline" size="sm" onClick={() => navigate('/app/approvals')}>
                  {t('lease_review.intake.approval_queue')}
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
                {/* Manual "Move to Under Review / Approved / Mark Executed" overrides
                    were removed (2026-06-23, Cluster A #2): they bypassed the
                    approval queue/chain (and the executed-document upload) and were
                    silently rejected by the prevent_unauthorized_lease_workflow_edits
                    trigger anyway. Approvals go through the Approval Queue; executed
                    status comes from uploading the executed document. */}
                {/* Wave 5: gated like the sibling Nudge button — the server
                    (legacy-lease-action) only allows the requestor or an
                    admin to cancel; anyone else got a confirm dialog followed
                    by a raw non-2xx error. */}
                {!isReadOnly && (isRequestor || isAdminUser) && lifecycleStatus && !['active', 'expired', 'cancelled', 'rejected'].includes(lifecycleStatus) && (
                  <Button
                    variant="outline"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      if (window.confirm(t('lease_review.intake.cancel_request_confirm'))) {
                        handleCancelRequest();
                      }
                    }}
                  >
                    {t('lease_review.intake.cancel_request')}
                  </Button>
                )}
              </div>
            }
          />

          {/* #137: read-only note as a standalone caption under the header, not
              wedged into the actions button-row (cramped at narrow widths). */}
          {isReadOnly && (
            <p className="text-sm text-muted-foreground">{t(readOnlyNoteKey)}</p>
          )}

          {/* Role-aware next-step guidance. #137: suppressed under read-only —
              the "upload the executed document" / "action required" copy would
              instruct a write the read-only caption above just said is disabled. */}
          {!isReadOnly && nextStepBanner && (
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
                <p className="font-medium text-amber-800 dark:text-amber-300">{t('lease_review.banners.returned_title')}</p>
                {lease?.financial_rejection_reason && (
                  <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                    "{lease.financial_rejection_reason}"
                  </p>
                )}
                {/* #137: the resubmit instruction is a write directive — hide it
                    under read-only (the rejection reason above stays, it's info). */}
                {!isReadOnly && (
                  <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">
                    {t('lease_review.banners.returned_hint')}
                  </p>
                )}
              </div>
              {!isReadOnly && (
                <Button size="sm" variant="outline" className="flex-shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100" onClick={openResubmit}>
                  <RotateCcw className="h-4 w-4 mr-1.5" />
                  {t('lease_review.resubmit.title')}
                </Button>
              )}
            </div>
          )}

          {/* Cancelled/rejected requests now render the dedicated terminal view
              (above, before this intake-stage branch) — isIntakeStage excludes
              terminal states, so a banner here was never reachable. */}

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Report Attributes */}
            <Card className="lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2">
                  <CardTitle>{t('lease_review.intake.report_attributes')}</CardTitle>
                  {!isReadOnly && !editingRequest && !lease.requesting_department && (
                    <button
                      className="text-xs text-amber-600 border border-amber-400 rounded-full px-2 py-0.5 hover:bg-amber-50 transition-colors"
                      onClick={() => {
                        setEditingRequest(true);
                        setTimeout(() => document.getElementById('report-attr-department')?.focus(), 50);
                      }}
                    >
                      {t('lease_review.intake.add_department')}
                    </button>
                  )}
                </div>
                {!isReadOnly && !editingRequest && (
                  <Button variant="ghost" size="sm" onClick={() => setEditingRequest(true)}>{t('common.edit')}</Button>
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
                    }}>{t('common.cancel')}</Button>
                    <Button size="sm" disabled={savingEdits} onClick={saveRequestEdits}>
                      {savingEdits ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                      {t('common.save')}
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="text-sm">
                {editingRequest ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <Label className="text-xs font-medium text-muted-foreground">{t('lease_review.fields.asset_type')}</Label>
                      <select
                        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={requestEdits.asset_type}
                        onChange={(e) => setRequestEdits(prev => ({ ...prev, asset_type: e.target.value }))}
                      >
                        <option value="">{t('lease_review.intake.select_placeholder')}</option>
                        {assetTypes.map((assetType) => <option key={assetType} value={assetType}>{assetType}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs font-medium text-muted-foreground">{t('lease_review.fields.region')}</Label>
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
                      <Label className="text-xs font-medium text-muted-foreground">{t('lease_review.fields.location')}</Label>
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
                      <Label className="text-xs font-medium text-muted-foreground">{t('lease_review.fields.building')}</Label>
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
                      <Label className="text-xs font-medium text-muted-foreground">{t('lease_review.fields.department')}</Label>
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
                    <p><span className="font-medium">{t('lease_review.fields.asset_type')}:</span> {(lease as any).asset_type || '\u2014'}</p>
                    <p><span className="font-medium">{t('lease_review.fields.region')}:</span> {(lease as any).region || '\u2014'}</p>
                    <p><span className="font-medium">{t('lease_review.fields.location')}:</span> {(lease as any).location || '\u2014'}</p>
                    <p><span className="font-medium">{t('lease_review.fields.building')}:</span> {(lease as any).building || '\u2014'}</p>
                    <p className="col-span-2"><span className="font-medium">{t('lease_review.fields.department')}:</span> {lease.requesting_department || '\u2014'}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>{t('lease_review.intake.internal_notes')}</CardTitle>
                {!editingRequest && (
                  <Button variant="ghost" size="sm" onClick={() => setEditingRequest(true)}>{t('common.edit')}</Button>
                )}
                {editingRequest && (
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => {
                      setEditingRequest(false);
                      setRequestEdits(prev => ({ ...prev, request_description: lease.request_description || (lease as any).notes || '' }));
                    }}>{t('common.cancel')}</Button>
                    <Button size="sm" disabled={savingEdits} onClick={saveRequestEdits}>
                      {savingEdits ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                      {t('common.save')}
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                {editingRequest ? (
                  <textarea
                    rows={4}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    placeholder={t('lease_review.intake.notes_placeholder')}
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
              <CardHeader><CardTitle>{t('lease_review.intake.attachments')}</CardTitle></CardHeader>
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
                        else toast.error(t('lease_review.toasts.download_link_failed'));
                      }}
                    >
                      {t('common.download')}
                    </Button>
                  </div>
                )}

                {!isReadOnly && (
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
                      {stageFile ? stageFile.name : t('lease_review.intake.click_to_select')}
                    </p>
                  </div>
                )}

                {!isReadOnly && stageFile && (
                  <div className="flex items-center justify-between rounded-md border p-2 text-sm">
                    <span className="truncate">{stageFile.name}</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setStageFile(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                {!isReadOnly && (
                  <Button onClick={handleStageDocumentUpload} disabled={uploadingStageFile || !stageFile} variant="outline" className="w-full">
                    {uploadingStageFile ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
                    {t('lease_review.intake.upload_document')}
                  </Button>
                )}

                {/* Phase 4 — upload executed document when approved */}
                {!isReadOnly && lifecycleStatus === 'approved' && (
                  <UploadExecutedDocumentDialog
                    leaseId={lease.id}
                    leaseFilename={lease.filename || ''}
                    onSuccess={refetchLease}
                  />
                )}

                {isReadOnly && (
                  <p className="text-sm text-muted-foreground">{t(readOnlyNoteKey)}</p>
                )}
              </CardContent>
          </Card>

          {(lease.monthly_payment || lease.term_months) && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <DollarSign size={14} className="text-green-600" />
                    {t('lease_review.intake.financial_terms')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">{t('lease_review.intake.monthly_payment')}</p>
                    <p className="font-medium">
                      {lease.monthly_payment ? formatLocalizedCurrency(Number(lease.monthly_payment), language) : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('lease_review.intake.term')}</p>
                    <p className="font-medium">{lease.term_months ? t('lease_review.intake.term_months_value', { count: Number(lease.term_months) }) : '\u2014'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('lease_review.fields.asset_type')}</p>
                    <p className="font-medium">{lease.asset_type ? localizedAssetTypeName(lease.asset_type) : '\u2014'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('lease_review.intake.escalation_rate')}</p>
                    <p className="font-medium">
                      {lease.escalation_rate != null ? t('lease_review.intake.escalation_rate_value', { rate: lease.escalation_rate }) : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('lease_review.intake.start_date')}</p>
                    <p className="font-medium">
                      {lease.lease_start ? formatLocalizedDate(lease.lease_start, language) : '\u2014'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t('lease_review.intake.end_date')}</p>
                    <p className="font-medium">
                      {lease.lease_start && lease.term_months ? (() => {
                        const end = new Date(lease.lease_start);
                        end.setMonth(end.getMonth() + Number(lease.term_months));
                        return formatLocalizedDate(end, language);
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
                      {t('lease_review.intake.financial_impact')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {lease.covenant_flagged && (
                      <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
                        <AlertTriangle size={12} />
                        {t('lease_review.intake.covenant_warning')}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">{t('lease_review.intake.total_commitment')}</p>
                        <p className="font-medium">
                          {lease.calc_total_commitment
                            ? formatLocalizedCurrency(Number(lease.calc_total_commitment), language)
                            : '\u2014'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('lease_review.intake.pv_liability')}</p>
                        <p className="font-medium">
                          {lease.calc_pv_liability
                            ? formatLocalizedCurrency(Number(lease.calc_pv_liability), language)
                            : '\u2014'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('lease_review.intake.monthly_pl')}</p>
                        <p className="font-medium">
                          {lease.calc_straight_line_exp
                            ? formatLocalizedCurrency(Number(lease.calc_straight_line_exp), language)
                            : '\u2014'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('lease_review.intake.cash_pl_delta')}</p>
                        <p className="font-medium">
                          {lease.calc_cash_pl_delta != null
                            ? formatLocalizedCurrency(Number(lease.calc_cash_pl_delta), language)
                            : '\u2014'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <p className="text-xs text-muted-foreground">{t('lease_review.intake.classification')}</p>
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
                          ? t('lease_review.intake.classification_pending')
                          : lease.lease_classification === 'operating'
                          ? t('lease_review.intake.classification_operating')
                          : lease.lease_classification === 'finance'
                          ? t('lease_review.intake.classification_finance')
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
        </div>

        {/* Phase 2 — Resubmit Dialog */}
        <Dialog open={resubmitDialogOpen} onOpenChange={(o) => !o && setResubmitDialogOpen(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('lease_review.resubmit.title')}</DialogTitle>
              <DialogDescription>
                {t('lease_review.resubmit.description')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="rs-payment" className="text-sm">{t('lease_review.resubmit.monthly_payment')}</Label>
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
                  <Label htmlFor="rs-term" className="text-sm">{t('locked_lease.timing.term_months')}</Label>
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
                  <Label htmlFor="rs-esc" className="text-sm">{t('lease_review.resubmit.annual_escalation')}</Label>
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
                <Label htmlFor="rs-start" className="text-sm">{t('lease_review.intake.start_date')}</Label>
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
                  {t('lease_review.resubmit.covenant_checkbox')}
                </label>
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => setResubmitDialogOpen(false)} disabled={resubmitting}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleResubmit} disabled={resubmitting || !resubmitFields.monthlyPayment || !resubmitFields.termMonths}>
                {resubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <RotateCcw className="h-4 w-4 mr-2" />
                {t('lease_review.resubmit.submit')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </AppLayout>
    );
  }

  // Terminal-negative request states (cancelled / rejected) must NOT fall
  // through to the editable workbench — that surfaced an "approve" primary
  // action on a dead request with no terminal messaging (and the intake view's
  // cancelled banner was unreachable, since isIntakeStage excludes terminal
  // states). Render a clear terminal view instead. isEquivalent(x,'cancelled')
  // matches the terminal_negative group — both 'cancelled' and 'rejected'.
  if (lifecycleStatusTyped != null && isEquivalent(lifecycleStatusTyped, 'cancelled') && lease) {
    const isCancelled = lifecycleStatusTyped === 'cancelled';
    const rejectionReason = isCancelled
      ? null
      : (lease.financial_rejection_reason || lease.manager_rejection_reason || lease.rejection_reason || null);
    return (
      <AppLayout>
        <div className="p-6 space-y-4">
          <AppHeader
            title={lease.request_title || t('lease_review.intake.lease_request_fallback')}
            subtitle={
              <div className="flex items-center gap-2">
                <LifecycleStatusBadge status={lease.lifecycle_status as any} />
                <span className="text-sm text-muted-foreground">{lease.requesting_department || t('lease_review.intake.unknown_department')}</span>
              </div>
            }
            actions={
              <Button variant="outline" size="sm" onClick={() => navigate('/app/leases')}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                {t('lease.back_to_leases')}
              </Button>
            }
          />
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center space-y-2">
            <X className="h-7 w-7 text-destructive mx-auto" />
            <p className="text-sm font-medium text-destructive">
              {isCancelled ? t('lease_review.terminal.cancelled') : t('lease_review.terminal.rejected')}
            </p>
            {rejectionReason && (
              <p className="text-sm text-muted-foreground max-w-prose mx-auto">&ldquo;{rejectionReason}&rdquo;</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('lease_review.terminal.preserved')}
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  // Locked + active leases render the read-only informational layout
  // (sectioned cards, vendor stays editable). All other states fall through
  // to the existing workbench below.
  if (lease?.model_locked === true && lease?.lifecycle_status === 'active') {
    return <LockedLeaseDetail lease={lease} refetchLease={refetchLease} readOnly={isReadOnly} onAscDirtyChange={setAscDirty} />;
  }

  // Derive a single primary action for the header. This is the
  // counterpart to the status strip: the strip names what's next; this
  // button does it. Order = forward-progression priority.
  type PrimaryAction = {
    label: string;
    icon: typeof CheckCircle;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: 'default' | 'success';
    tooltip?: string;
  } | null;

  const unreviewedLowConfCount = lowConfidenceFields.length - interactedLowConfFields.size;
  const isUnlockedDraft = !lease.model_locked && activeChangeSet?.status === 'draft' && !isReadOnly;
  const canShowLock = !lease.model_locked && (lifecycleStatus === 'executed' || lifecycleStatus === 'active') && !isReadOnly;

  // Payload for inline Export JSON / CSV menu items. Mirrors what was
  // previously passed to the old <LeaseExports/> button.
  const exportLeasePayload = {
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
  };

  const primaryAction: PrimaryAction = (() => {
    if (isReadOnly) return null; // Vault: view + export only, no mutating primary action
    if (isProcessing) return null;
    // P1-1: chain post-concept states drive their workflow from the Documents
    // tab (in_negotiation: upload/advance/send-back; pending_counter_signature:
    // CounterSignaturePanel; chain_violation: ChainViolationBanner; final_review:
    // the separate signator-review route). The legacy header approve/reopen/lock
    // actions do NOT apply — and 'approved' here is a legacy _approval blob the
    // chain flow never writes, so without this guard an in_negotiation lease
    // would render a stray "Approve/Pending Review" button (server-rejected and
    // confusing). No header primary action for these states.
    if (isPostConceptChain) return null;
    // P1-5: a counter-signed chain lease at 'fully_executed' — the missing last
    // step. Offer "Finalize & activate": abstract the executed document into the
    // primary terms and activate + model-lock the lease. This is the human-in-
    // the-loop trigger for the AI abstraction the chain path otherwise never got.
    if (lifecycleStatus === 'fully_executed') {
      return {
        label: t('lease_review.header.finalize_activate'),
        icon: Lock,
        onClick: handleFinalize,
        loading: runningAbstraction,
        variant: 'success',
        tooltip: t('lease_review.header.finalize_tooltip'),
      };
    }
    if (isUnlockedDraft) return null; // handled by Cancel + Save Changes inline
    if (unreviewedLowConfCount > 0) {
      return {
        label: t('lease_review.header.review_flagged', { count: unreviewedLowConfCount }),
        icon: AlertTriangle,
        onClick: handleJumpToFirstFlagged,
      };
    }
    if (!isApproved && !isLocked) {
      // Label encodes WHY the button is disabled when canApprove is
      // false: "Pending Review" tells the user review is incomplete,
      // not just that the button doesn't work. Flips to "Ready to
      // Approve" the moment all sections are confirmed.
      const ready = canApprove && !approving;
      return {
        label: ready ? t('lease_review.header.ready_to_approve') : t('lease_review.header.pending_review'),
        icon: ready ? CheckCircle : Clock,
        onClick: handleApproveLease,
        disabled: approving || !canApprove,
        loading: approving,
        variant: ready ? 'success' : undefined,
        tooltip: !canApprove ? t('lease_review.header.approve_tooltip') : undefined,
      };
    }
    if (canShowLock) {
      return {
        label: lifecycleStatus === 'executed' ? t('lease_review.header.activate') : t('lease_review.header.lock'),
        icon: Lock,
        onClick: () => setLockConfirmDialogOpen(true),
        loading: submittingChanges,
        variant: 'success',
      };
    }
    if (isApproved && !lease.model_locked) {
      return {
        label: t('lease_review.header.reopen'),
        icon: RotateCcw,
        onClick: handleReopenLease,
        loading: reopening,
      };
    }
    return null;
  })();

  // Inline tab footer — one Reviewed affordance per tab, rendered at
  // the bottom of the tab's content. Replaces the per-section footers.
  // Uses green for confirmed (matches the page color scheme); outline
  // for unconfirmed. No "Mark" verb in the label — the button just
  // says "Reviewed" and its visual state announces what's true. The
  // approve action lives at the top of the page header — we
  // deliberately don't duplicate it here.
  const renderTabFooter = (tabKey: string) => {
    if (lease?.model_locked || isReadOnly) return null;
    // P1-1: no per-tab "Reviewed" confirm ceremony on a chain post-concept lease
    // — its terms were confirmed at concept approval and may still be in flux
    // during negotiation; these footers only feed the (now-suppressed) intake
    // approve gate and reinforce the wrong mental model.
    if (isPostConceptChrome) return null;
    const confirmed = isTabConfirmed(tabKey);
    const nextTab = REVIEW_TABS.find(
      (tab) => tab.key !== tabKey && !tab.sections.every((s) => confirmedSections.includes(s)),
    );
    return (
      <div className="border-t pt-3 mt-2 flex items-center justify-between gap-2">
        {confirmed ? (
          <Button
            size="sm"
            aria-pressed="true"
            className="h-7 text-xs gap-1 bg-green-600 hover:bg-green-700 text-white pr-1.5"
            onClick={() => handleConfirmTab(tabKey)}
            title={t('lease_review.tabs.reviewed_unmark_title')}
          >
            <Check size={12} />
            {t('lease_review.tabs.reviewed')}
            <X size={11} className="opacity-70 ml-0.5" />
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1 border-green-300 text-green-700 hover:bg-green-50 hover:text-green-800"
            onClick={() => handleConfirmTab(tabKey)}
          >
            <Check size={12} />
            {/* Imperative label: this is the action the user takes, not the
                state it sets — "Reviewed" read as a status indicator. */}
            {t('lease_review.tabs.mark_reviewed')}
          </Button>
        )}
        {nextTab ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => handleAdvanceTab(nextTab.key)}
            title={t('lease_review.tabs.go_to', { title: t(nextTab.title) })}
          >
            {t('lease_review.tabs.next', { title: t(nextTab.title) })}
            <ChevronRight size={12} />
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <AppLayout>
      {/* Phase 6 — submitter notification. Mounts at the top level so the
          modal appears regardless of which tab is active when the page
          loads. Self-gates on (current user === submitter && unseen
          reroute event); renders nothing otherwise. */}
      <RerouteNotificationModal
        leaseId={lease.id}
        requestorId={lease.requestor_id ?? null}
        userId={lease.user_id ?? null}
      />
      <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-muted/30">
        <AppHeader
          title={
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="truncate min-w-0">{lease.request_title || lease.property_address || lease.filename || t('lease_review.header.untitled_lease')}</span>
              {!isReadOnly && (
                <button
                  onClick={() => { setRenameValue(lease.request_title || ''); setRenameDialogOpen(true); }}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                  title={t('lease_review.header.rename_lease')}
                >
                  <Pencil size={13} />
                </button>
              )}
              {lease.lifecycle_status && (
                <span className="shrink-0">
                  <LifecycleStatusBadge status={lease.lifecycle_status as any} />
                </span>
              )}
              {isUnlockedDraft && (
                <Badge className="shrink-0 bg-amber-100 text-amber-800 border border-amber-300 text-xs dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800">
                  <Unlock size={11} className="mr-1" />
                  {stagedItemCount > 0 ? t('lease_review.header.editing_with_count', { count: stagedItemCount }) : t('lease_review.header.editing')}
                </Badge>
              )}
              {isApproved && (
                <Badge className="shrink-0 bg-green-600 text-white text-xs">
                  <CheckCircle size={12} className="mr-1" />
                  {t('lease.approved')}
                </Badge>
              )}
            </div>
          }
          actions={
            isUnlockedDraft ? (
              /* Unlocked-for-editing draft. Primary exit: "Submit for approval" — opens
                 the finalize dialog (submit_change_set / self-approve / empty-draft
                 re-lock, all attributable) AND first flushes any dirty-but-unblurred
                 edit into the change set so a just-typed value can't be dropped.
                 Discard / Archive live in the ⋯ menu so the bar can't overflow
                 off-screen and re-hide the exit at narrow widths. Edits auto-stage
                 on blur — there is intentionally NO separate direct-write "Save"
                 here (it bypassed the change-set audit chain). */
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="bg-green-600 hover:bg-green-700 text-white font-semibold shadow-sm"
                  onClick={async () => { await flushStagedEdits(); setLockConfirmDialogOpen(true); }}
                  disabled={submittingChanges || saving}
                  title={stagedItemCount > 0
                    ? t('lease_review.header.submit_tooltip')
                    : t('lease_review.header.lock_tooltip_no_changes')}
                >
                  {submittingChanges ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Lock size={14} className="mr-1.5" />}
                  {stagedItemCount > 0 ? t('lease_review.header.submit_for_approval') : t('lease_review.header.lock')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label={t('common.more_actions')}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem
                      onClick={() => setCancelChangeSetDialogOpen(true)}
                      disabled={cancelingChangeSet}
                      className="text-destructive focus:text-destructive"
                    >
                      <X className="h-4 w-4 mr-2" />
                      {t('common.cancel')}
                    </DropdownMenuItem>
                    {(userRole === 'admin' || userRole === 'owner') && (
                      <DropdownMenuItem onClick={() => setShowArchiveDialog(true)}>
                        <Archive className="h-4 w-4 mr-2" />
                        {lease.archived ? t('archive.unarchive') : t('archive.archive')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {/* Vault read-only: explain why no write affordances are present.
                    Mirrors the intake-branch note so non-intake states
                    (executed / active-unlocked / needs-review / archived) are
                    not silently action-less. */}
                {isReadOnly && (
                  <p className="text-sm text-muted-foreground">{t(readOnlyNoteKey)}</p>
                )}
                {/* Primary action — state-aware, visually dominant.
                    font-semibold + shadow + slight x-padding pull the
                    eye regardless of variant. */}
                {primaryAction && (
                  <Button
                    onClick={primaryAction.onClick}
                    disabled={primaryAction.disabled || primaryAction.loading}
                    className={
                      'font-semibold shadow-sm px-5 ' +
                      (primaryAction.variant === 'success' ? 'bg-green-600 hover:bg-green-700 text-white' : '')
                    }
                    title={primaryAction.tooltip}
                  >
                    {primaryAction.loading ? (
                      <Loader2 className="animate-spin mr-2" size={16} />
                    ) : (
                      <primaryAction.icon className="mr-2" size={16} />
                    )}
                    {primaryAction.label}
                  </Button>
                )}

                {/* State-specific secondary — nudge when pending (the workbench
                    path covers final_review; the intake header covers the
                    concept stages). P1-6: gated to the people who may nudge. */}
                {isPendingApproval && (isRequestor || isAdminUser) && !isReadOnly && (
                  <NudgeApproverButton leaseId={lease.id} lastNudgedAt={lease.last_nudged_at} />
                )}

                {/* Save draft surfaces as a visible secondary the moment
                    the form is dirty. Reversibility > frequency: it's a
                    paid feature people would resent losing work to. */}
                {/* hidden below md: at narrow widths the title was ellipsizing
                    to a few characters while this duplicate of the menu's
                    Save Draft item held its ground. The menu item remains. */}
                {isDirty && !isLocked && (
                  <Button size="sm" variant="outline" onClick={handleSync} disabled={saving} className="hidden md:inline-flex">
                    {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Save size={14} className="mr-1.5" />}
                    {t('lease_review.header.save_draft')}
                  </Button>
                )}

                {/* More menu — every other action lives here. Page should
                    pull (primary), not present (toolbar of 7). */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label={t('common.more_actions')}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    {/* Most reversible / most frequent first. Destructive
                        and state-changing actions sit below the
                        separator. */}
                    {!isLocked && (
                      <DropdownMenuItem onClick={handleSync} disabled={saving}>
                        {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                        {t('lease_review.header.save_draft')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => downloadCSV(exportLeasePayload, form, rentSchedule)}>
                      <Download className="h-4 w-4 mr-2" />
                      {t('audit.export_csv')}
                    </DropdownMenuItem>
                    {!isReadOnly && ((isMasterLease && !isProcessing) || (userRole === 'admin' || userRole === 'owner')) ? (
                      <DropdownMenuSeparator />
                    ) : null}
                    {!isReadOnly && isMasterLease && !isProcessing && (
                      <DropdownMenuItem onClick={() => setShowAmendmentDialog(true)}>
                        <Upload className="h-4 w-4 mr-2" />
                        {t('lease_review.header.upload_amendment')}
                      </DropdownMenuItem>
                    )}
                    {!isReadOnly && (userRole === 'admin' || userRole === 'owner') && (
                      <DropdownMenuItem onClick={() => setShowArchiveDialog(true)}>
                        <Archive className="h-4 w-4 mr-2" />
                        {lease.archived ? t('archive.unarchive') : t('archive.archive')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          }
        />

        {/* The status strip drives the review-and-approve workflow. Read-only
            (Vault) workspaces have no such decision to make, so suppress it.
            P1-1: chain post-concept states (negotiation/signature/etc.) are past
            that ceremony — the strip's "confirm sections → Ready to approve"
            answer is wrong there; the forward path is in the Documents tab. */}
        {!isReadOnly && !isPostConceptChrome && (
          <LeaseReviewStatusStrip
            isProcessing={isProcessing}
            modelLocked={!!lease.model_locked}
            isApproved={isApproved}
            isPendingApproval={isPendingApproval}
            canApprove={canApprove}
            lowConfidenceCount={lowConfidenceFields.length}
            unreviewedLowConfCount={lowConfidenceFields.length - interactedLowConfFields.size}
            onReview={handleJumpToFirstFlagged}
            confirmedSectionCount={confirmedTabsCount}
            totalRequiredSections={REVIEW_TABS.length}
            remainingSectionTitles={remainingTabTitles}
            requiredSectionTitles={REVIEW_TABS.map((tab) => t(tab.title))}
            onConfirmAllRequired={handleConfirmAllRequired}
          />
        )}

        <div className="flex-1 px-6 overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            className={cn(
              "h-full rounded-xl border bg-background shadow-sm overflow-hidden",
              // Chrome hugs content: without a PDF split the border caps at the
              // column width instead of framing empty gutters across the page.
              !showPdfPanel && "mx-auto w-full max-w-4xl",
            )}
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
                        {t('review.source_document')}
                      </span>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { pdfPanelRef.current?.collapse(); setIsPdfCollapsed(true); }} title={t('lease_review.pdf.collapse')} aria-label={t('lease_review.pdf.collapse')}>
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
                      onExitCapture={() => setPdfCaptureMode(false)}
                    />
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle className="bg-border w-1 hover:bg-primary transition-colors" />
              </>
            )}

            {/* Right Panel: Tabbed Review */}
            <ResizablePanel defaultSize={showPdfPanel ? 50 : 100} minSize={30}>
              {/* The whole right column scrolls as one (banners + tab content),
                  so a tall banner stack scrolls away instead of crushing the
                  form to a sliver, and the wheel works anywhere over the column
                  — not only over a nested inner scroll pane. The tab strip stays
                  pinned via `sticky` below. */}
              <div className="flex h-full flex-col bg-background overflow-y-auto">

                {/* Global banners — same centered column AND the same padding
                    topology as the tab content (outer gutter, inner max-w), so
                    banner cards align flush with the section cards below. */}
                <div className="px-4 pt-3">
                  <div className={cn("space-y-2 mx-auto w-full", showPdfPanel && !isPdfCollapsed ? "max-w-2xl" : "max-w-3xl")}>
                  {showPdfPanel && isPdfCollapsed && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => { pdfPanelRef.current?.expand(); setIsPdfCollapsed(false); }}
                      title={t('lease_review.pdf.reopen_title')}
                    >
                      <ChevronRight size={14} />
                      {t('lease_review.pdf.show')}
                    </Button>
                  )}
                  {/* Archived ("deleted") state banner — without it the page
                      renders identically after a delete and users conclude
                      the action failed. Restore reuses the archive dialog. */}
                  {lease.archived && (
                    // Neutral, not destructive-red: archive is reversible (mirrors LockedHeader).
                    <div className="rounded-lg border border-border bg-muted p-4 flex items-center justify-between gap-4 flex-wrap">
                      <p className="text-sm text-muted-foreground min-w-0 flex items-center gap-2">
                        <Archive className="h-4 w-4 shrink-0" />
                        {t('archive.deleted_banner')}
                      </p>
                      {!isReadOnly && (userRole === 'admin' || userRole === 'owner') && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => setShowArchiveDialog(true)}
                        >
                          {t('archive.unarchive')}
                        </Button>
                      )}
                    </div>
                  )}
                  {isFailedStatus(lease?.status) && (
                    <FailedLeaseBanner
                      leaseId={lease.id}
                      errorMessage={lease.error_message}
                      storagePath={lease.storage_path}
                      onRetrySuccess={refetchLease}
                      readOnly={isReadOnly}
                    />
                  )}
                  {/* Self-gating: NeedsReviewBanner returns null unless a Tier-1
                      field is missing or low-confidence. Suppressed only for
                      Failed leases — FailedLeaseBanner (above) already owns that
                      state, and a failed extraction has no fields so every Tier-1
                      field would list as "missing" (duplicate noise). The old
                      needsReviewStatus() gate matched lifecycle strings no lease
                      ever has, so the banner never rendered at all. */}
                  {!isFailedStatus(lease?.status) && (
                    <NeedsReviewBanner
                      landlordName={form.landlord_name}
                      tenantName={form.tenant_name}
                      leaseStart={form.lease_start}
                      leaseEnd={form.lease_end}
                      extractedJson={extractedJson}
                    />
                  )}
                  {Array.isArray(extractedJson?._parent_lease_candidates) && extractedJson._parent_lease_candidates.length > 0 && (
                    <div className="rounded-lg border border-purple-300 bg-purple-50 p-4">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-purple-600 mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <h4 className="font-semibold text-purple-800 text-sm mb-1">{t('lease_review.banners.parent_candidates_title')}</h4>
                          <p className="text-xs text-purple-700/80 mb-2">
                            {t('lease_review.banners.parent_candidates_body')}
                          </p>
                          <ul className="text-sm text-purple-700 space-y-2">
                            {extractedJson._parent_lease_candidates.map((c) => (
                              <li key={c.id} className="flex items-start gap-2">
                                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-purple-500" />
                                <div className="flex-1">
                                  <Link
                                    to={`/app/leases/${c.id}/review`}
                                    className="font-medium underline hover:text-purple-900"
                                  >
                                    {c.request_title || c.tenant_name || t('lease_review.banners.lease_fallback_label', { id: c.id.slice(0, 8) })}
                                  </Link>
                                  <span className="text-xs text-purple-700/70">
                                    {' — '}{t('lease_review.banners.matches_on', { reasons: c.match_reasons.join(' + ') })}
                                    {c.lifecycle_status ? ` · ${localizedStatusLabel(c.lifecycle_status as LifecycleStatus)}` : ''}
                                  </span>
                                </div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}
                  {Array.isArray(extractedJson?._tier2_warnings) && extractedJson._tier2_warnings.length > 0 && (
                    <div className="rounded-lg border border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20 p-4">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <h4 className="font-semibold text-blue-800 dark:text-blue-300 text-sm mb-1">{t('lease_review.banners.tier2_title')}</h4>
                          <p className="text-xs text-blue-700/80 dark:text-blue-400/80 mb-2">
                            {t('lease_review.banners.tier2_body')}
                          </p>
                          <ul className="text-sm text-blue-700 dark:text-blue-300 space-y-1">
                            {extractedJson._tier2_warnings.map((warning, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
                                <span>{warning}</span>
                              </li>
                            ))}
                          </ul>
                          {!isReadOnly && workspace?.id && (
                            <button
                              type="button"
                              onClick={() => setTier2CorrectionOpen(true)}
                              className="mt-2 text-xs font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
                            >
                              {t('lease_review.banners.tier2_correction_cta')}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {Array.isArray(extractedJson?._validation_warnings) && extractedJson._validation_warnings.length > 0 && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20 p-4">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <h4 className="font-semibold text-amber-800 dark:text-amber-300 text-sm mb-1">{t('lease_review.banners.validation_title')}</h4>
                          <ul className="text-sm text-amber-700 dark:text-amber-300 space-y-1">
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
                      {t('lease_review.strip.flagged_label', { count: lowConfidenceFields.length })}
                    </Badge>
                  )}
                  {/* Staged-edits status — lifted here from the General tab so
                      the "changes need approval" context is identical
                      on every editable tab (Rent/Options included), not just
                      General. activeChangeSet only exists for an executed/active
                      lease in a governed edit session, so this stays hidden in
                      normal intake/review. */}
                  {!lease.model_locked && activeChangeSet && (
                    <Card className="shadow-none border border-blue-300 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
                      <CardContent className="py-3 px-4">
                        <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
                          {activeChangeSet.status === 'draft'
                            ? t('lease_review.banners.staged_editing_title')
                            : t('lease_review.banners.staged_pending_title')}
                        </p>
                        <p className="text-xs text-blue-700 dark:text-blue-400 mt-0.5">
                          {activeChangeSet.status === 'draft'
                            ? t('lease_review.banners.staged_editing_body')
                            : t('lease_review.banners.staged_pending_body')}
                        </p>
                      </CardContent>
                    </Card>
                  )}
                  </div>
                </div>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col px-4 pt-2">
                  {/* Tabs use shortened labels so the row fits the right
                      panel even at 50% split (with PDF visible). Full
                      labels surface as tooltips. ScrollableTabStrip owns
                      horizontal overflow (edge fades cue clipped tabs, the
                      active tab is kept in view) so it never pans the page. */}
                  <ScrollableTabStrip activeValue={activeTab} className="sticky top-0 z-10 shrink-0 border-b border-border bg-background">
                    <TabsList className="w-max min-w-full justify-start rounded-none bg-background p-0 h-auto items-end">
                      <TabsTrigger className={UNDERLINE_TAB_TRIGGER} value="general" title={t('locked_lease.tabs.general')}>{t('lease_review.tabs.general')}</TabsTrigger>
                      <TabsTrigger className={UNDERLINE_TAB_TRIGGER} value="vendor" title={t('lease_review.tabs.vendor_full')}>{t('locked_lease.vendor.title')}</TabsTrigger>
                      <TabsTrigger className={UNDERLINE_TAB_TRIGGER} value="rent" title={t('locked_lease.tabs.rent')}>{t('locked_lease.tabs.rent')}</TabsTrigger>
                      <TabsTrigger className={UNDERLINE_TAB_TRIGGER} value="options" title={t('lease_review.tabs.options_full')}>{t('lease_review.tabs.options')}</TabsTrigger>
                      <TabsTrigger className={UNDERLINE_TAB_TRIGGER} value="risks" title={t('locked_lease.tabs.risks')}>{t('locked_lease.tabs.risks')}</TabsTrigger>
                      <TabsTrigger className={UNDERLINE_TAB_TRIGGER} value="documents" title={t('locked_lease.tabs.documents')}>{t('locked_lease.tabs.documents')}</TabsTrigger>
                      <TabsTrigger className={UNDERLINE_TAB_TRIGGER} value="asc842" title={t('lease_review.tabs.asc842_full')}>ASC 842</TabsTrigger>
                    </TabsList>
                  </ScrollableTabStrip>

                  {/* pb-8 (was pb-24): the sticky footer that needed the runway
                      was removed 2026-06-23. Collapsed-PDF counts as wide. */}
                  <div className={cn("py-4 space-y-4 mx-auto w-full pb-8", showPdfPanel && !isPdfCollapsed ? "max-w-2xl" : "max-w-3xl")}>

                      {/* General Information */}
                      <TabsContent value="general" className="mt-0 space-y-4">
                        {(['parties', 'property', 'dates'] as SectionKey[]).map((sectionKey) => (
                          <SectionCard
                            key={sectionKey}
                            sectionKey={sectionKey}
                            form={form}
                            extractedJson={extractedJson}
                            confidenceScores={confidenceScores}
                            isLocked={isLocked && !isUnlockedForEditing}
                            isModelLocked={!!lease?.model_locked}
                            hideConfidence={lifecycleStatus === 'active'}
                            assetTypes={assetTypes}
                            onFieldChange={handleFieldChange}
                            onFieldFocus={handleFieldFocus}
                            onFieldBlur={trackFieldCorrection}
                            onFieldStaged={stageFieldImmediate}
                            sourceViewable={showPdfPanel}
                            allowTwoUp={!showPdfPanel || isPdfCollapsed}
                            onJumpToPage={jumpToPage}
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
                                      {t('lease_review.parent.current_terms')}
                                    </span>
                                    <ChevronDown className={cn("h-4 w-4 text-blue-600 transition-transform", showParentTerms && "rotate-180")} />
                                  </CardTitle>
                                </CardHeader>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <CardContent className="pt-0 pb-4 grid grid-cols-2 gap-4 text-sm">
                                  <div>
                                    <Label className="text-[10px] uppercase text-blue-600">{t('review.landlord')}</Label>
                                    <p className="font-medium">{parentLease.landlord_name || t('review.confidence.na')}</p>
                                  </div>
                                  <div>
                                    <Label className="text-[10px] uppercase text-blue-600">{t('review.tenant')}</Label>
                                    <p className="font-medium">{parentLease.tenant_name || t('review.confidence.na')}</p>
                                  </div>
                                  <div>
                                    <Label className="text-[10px] uppercase text-blue-600">{t('review.monthly_rent')}</Label>
                                    <p className="font-medium">
                                      {parentLease.current_monthly_rent != null
                                        ? formatLocalizedCurrency(Number(parentLease.current_monthly_rent), language)
                                        : parentLease.base_rent_amount || t('review.confidence.na')}
                                    </p>
                                  </div>
                                  <div>
                                    <Label className="text-[10px] uppercase text-blue-600">{t('review.lease_end')}</Label>
                                    <p className="font-medium">
                                      {parentLease.lease_end ? formatLocalizedDate(parentLease.lease_end, language) : t('review.confidence.na')}
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
                        {/* Unlock + change-set status cards. The executed-
                            terms reconciliation surface (ExecutedTermsReview +
                            VarianceReport) was removed 2026-06-04; the
                            unlock/staging affordances below remain. */}
                        {(lifecycleStatus === 'executed' || lifecycleStatus === 'active') && (
                          <>
                            {lease.model_locked && isAdminUser && pendingUnlockRequest && (
                              <Card className="shadow-none border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
                                <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{t('lease_review.unlock.requested_title')}</p>
                                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                                      {t('lease_review.unlock.requested_body')}
                                      {pendingUnlockRequest.request_reason && (
                                        <> {t('lease_review.unlock.reason', { reason: pendingUnlockRequest.request_reason })}</>
                                      )}
                                      {pendingUnlockRequest.created_at && (
                                        <> {t('lease_review.unlock.submitted_date', { date: formatLocalizedDate(pendingUnlockRequest.created_at, language) })}</>
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
                                      {t('lease_review.unlock.approve_unlock')}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-muted-foreground"
                                      onClick={handleDenyUnlock}
                                    >
                                      {t('locked_lease.deny_unlock')}
                                    </Button>
                                  </div>
                                </CardContent>
                              </Card>
                            )}
                            {lease.model_locked && isAdminUser && !pendingUnlockRequest && (
                              <Card className="shadow-none border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
                                <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">{t('lease_review.unlock.admin_title')}</p>
                                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">{t('lease_review.unlock.admin_body')}</p>
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100 dark:text-amber-300"
                                    onClick={handleUnlockLease}
                                  >
                                    <RotateCcw size={14} className="mr-1.5" />
                                    {t('locked_lease.admin_unlock')}
                                  </Button>
                                </CardContent>
                              </Card>
                            )}
                            {lease.model_locked && !isAdminUser && (
                              <Card className="shadow-none border">
                                <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-sm font-medium">{t('lease_review.unlock.request_title')}</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">
                                      {pendingUnlockRequest
                                        ? t('lease_review.unlock.request_pending')
                                        : t('lease_review.unlock.request_hint')}
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
                                      {t('lease_review.unlock.request_button')}
                                    </Button>
                                  )}
                                  {pendingUnlockRequest && (
                                    <Badge variant="outline" className="shrink-0">{t('lease_review.unlock.pending_badge')}</Badge>
                                  )}
                                </CardContent>
                              </Card>
                            )}
                          </>
                        )}
                        {renderTabFooter('general')}
                      </TabsContent>

                      {/* Vendor / Counterparty */}
                      <TabsContent value="vendor" className="mt-0 space-y-4">
                        <SectionCard
                          sectionKey="vendor"
                          form={form}
                          extractedJson={extractedJson}
                          confidenceScores={confidenceScores}
                          isLocked={isLocked && !isUnlockedForEditing}
                          isModelLocked={!!lease?.model_locked}
                          hideConfidence={lifecycleStatus === 'active'}
                          onFieldChange={handleFieldChange}
                          onFieldFocus={handleFieldFocus}
                          onFieldBlur={trackFieldCorrection}
                          onFieldStaged={stageFieldImmediate}
                          sourceViewable={showPdfPanel}
                          allowTwoUp={!showPdfPanel || isPdfCollapsed}
                          onJumpToPage={jumpToPage}
                        />
                        {renderTabFooter('vendor')}
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
                            isLocked={isLocked && !isUnlockedForEditing}
                            isModelLocked={!!lease?.model_locked}
                            hideConfidence={lifecycleStatus === 'active'}
                            onFieldChange={handleFieldChange}
                            onFieldFocus={handleFieldFocus}
                            onFieldBlur={trackFieldCorrection}
                            onFieldStaged={stageFieldImmediate}
                            sourceViewable={showPdfPanel}
                            allowTwoUp={!showPdfPanel || isPdfCollapsed}
                            onJumpToPage={jumpToPage}
                          />
                        ))}
                        {/* H1 (integrity): the schedule table is intentionally
                            NOT carved out for unlock-for-editing. handleScheduleChange
                            writes rent_schedules directly (no change-set staging,
                            no audit row), so editing it in a governed unlock
                            session would produce an un-attributed rent change the
                            approver never sees. The rent FIELDS above stage through
                            the change set; hand-editing the schedule on a posted
                            lease must wait for governed routing (Stream C). */}
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
                        {renderTabFooter('rent')}
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
                            isLocked={isLocked && !isUnlockedForEditing}
                            isModelLocked={!!lease?.model_locked}
                            hideConfidence={lifecycleStatus === 'active'}
                            onFieldChange={handleFieldChange}
                            onFieldFocus={handleFieldFocus}
                            onFieldBlur={trackFieldCorrection}
                            onFieldStaged={stageFieldImmediate}
                            sourceViewable={showPdfPanel}
                            allowTwoUp={!showPdfPanel || isPdfCollapsed}
                            onJumpToPage={jumpToPage}
                          />
                        ))}
                        {renderTabFooter('options')}
                      </TabsContent>

                      {/* Risks */}
                      <TabsContent value="risks" className="mt-0 space-y-2">
                        {!isReadOnly && (
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              onClick={() => setAddRiskOpen(true)}
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t('lease_review.risks.add_risk')}
                            </Button>
                          </div>
                        )}
                        {/* Omit leaseId for read-only (Vault) so RisksSection
                            hides its dismiss (write) affordance. */}
                        <RisksSection
                          risks={risks}
                          onJumpToPage={jumpToPage}
                          sourceViewable={showPdfPanel}
                          leaseId={isReadOnly ? undefined : lease?.id}
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

                      {/* ASC 842 Inputs — full per-lease capture for measurement,
                          classification, term assessment, and disclosure. The fields
                          here are NOT extracted by the AI pipeline. forceMount: the
                          tab holds unsaved local state, and the natural gesture
                          (flip to Documents to check the PDF, flip back) must not
                          destroy it. */}
                      <TabsContent value="asc842" forceMount className="mt-0 data-[state=inactive]:hidden">
                        {ascTabTouched && lease?.id && lease?.workspace_id && (
                          <Asc842InputsTab
                            leaseId={lease.id}
                            workspaceId={lease.workspace_id}
                            onDirtyChange={setAscDirty}
                            canEdit={
                              !isReadOnly && (
                                userRole === 'admin' ||
                                userRole === 'owner' ||
                                userRole === 'editor'
                              )
                            }
                            discountRate={lease.discount_rate ?? null}
                            baseTermMonths={lease.term_months ?? null}
                            lifecycleStatus={lifecycleStatus ?? null}
                            reportAvailable={!!lease.model_locked}
                            storedClassification={lease.lease_classification ?? null}
                            discountRateSlot={
                              /* The IBR/discount rate is the report's most
                                 important measurement input — surfaced during
                                 capture, inside the sticky bar's reach. */
                              <LeaseDiscountRateCard
                                leaseId={lease.id}
                                workspaceId={lease.workspace_id}
                                canEdit={
                                  !isReadOnly && (
                                    userRole === 'admin' ||
                                    userRole === 'owner' ||
                                    userRole === 'editor'
                                  )
                                }
                              />
                            }
                          />
                        )}
                      </TabsContent>

                      {/* Documents */}
                      <TabsContent value="documents" className="mt-0 space-y-4">
                        {/* Phase 4 — negotiation document iteration timeline.
                            Renders above the legacy storage_path/executed_storage_path
                            panel so the new iteration model is the primary surface;
                            the legacy panel stays for backward compat with leases
                            that pre-date Phase 4. */}
                        <DocumentsPanel
                          leaseId={lease.id}
                          workspaceId={lease.workspace_id}
                          lifecycleStatus={lease.lifecycle_status ?? ''}
                          requestorId={lease.requestor_id ?? null}
                          userId={lease.user_id ?? null}
                          onLifecycleChanged={() => {
                            queryClient.invalidateQueries({ queryKey: ['lease', leaseId] });
                          }}
                          readOnly={isReadOnly}
                        />
                        {/* Chain-negotiation action panels are write surfaces;
                            on a read-only (Vault) workspace a lease that was
                            mid-chain at conversion shows the read-only note
                            instead, never live counter-signature / violation-
                            override actions that would fail at the server. */}
                        {isReadOnly &&
                          (lease.lifecycle_status === 'pending_counter_signature' ||
                            lease.lifecycle_status === 'chain_violation') && (
                            <p className="text-sm text-muted-foreground">
                              {t(readOnlyNoteKey)}
                            </p>
                          )}
                        {!isReadOnly && lease.lifecycle_status === 'pending_counter_signature' && (
                          <CounterSignaturePanel
                            leaseId={lease.id}
                            workspaceId={lease.workspace_id}
                            lifecycleStatus={lease.lifecycle_status}
                            requestorId={lease.requestor_id ?? null}
                            userId={lease.user_id ?? null}
                            executionOwnerId={lease.execution_owner_id ?? null}
                            dueDate={lease.counter_signature_due_date ?? null}
                            reminderCount={lease.counter_signature_reminder_count ?? 0}
                            onChanged={() => {
                              queryClient.invalidateQueries({ queryKey: ['lease', leaseId] });
                            }}
                          />
                        )}
                        {!isReadOnly && lease.lifecycle_status === 'chain_violation' && (
                          <ChainViolationBanner
                            leaseId={lease.id}
                            workspaceId={lease.workspace_id}
                            lifecycleStatus={lease.lifecycle_status}
                            onResolved={() => {
                              queryClient.invalidateQueries({ queryKey: ['lease', leaseId] });
                            }}
                          />
                        )}
                        <div data-reroute-history>
                          <RerouteHistorySection leaseId={lease.id} />
                        </div>
                        <LeaseDocumentsTab
                          leaseId={lease.id}
                          filename={lease.filename}
                          storagePath={lease.storage_path}
                          executedFilename={lease.executed_filename}
                          executedStoragePath={lease.executed_storage_path}
                          isLocked={!!lease.model_locked || isReadOnly}
                          onDocumentDeleted={refetchLease}
                        />
                        {isMasterLease && (
                          <AmendmentsList
                            parentLeaseId={lease.id}
                            refreshTrigger={amendmentsRefresh}
                            readOnly={isReadOnly}
                          />
                        )}
                      </TabsContent>

                  </div>
                </Tabs>

              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>

        {/* The "Post Lease" sticky footer was removed 2026-06-23 (Cluster A #3):
            it activated an under_review lease straight to 'active' — an INVALID
            lifecycle transition (skips approved → executed) and a governance
            bypass (it was silently rejected by the workflow trigger anyway).
            under_review requests advance through the Approval Queue (linked in
            the header); a reviewed executed lease activates via Activate. */}
      </div>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('lease_review.rename_dialog.title')}</DialogTitle>
            <DialogDescription>{t('lease_review.rename_dialog.description')}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={lease?.filename || t('lease_review.rename_dialog.placeholder')}
            onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={saveRename}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Confirmation Dialog */}
      <Dialog open={cancelChangeSetDialogOpen} onOpenChange={setCancelChangeSetDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('lease_review.discard_dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('lease_review.discard_dialog.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelChangeSetDialogOpen(false)} disabled={cancelingChangeSet}>
              {t('lease_review.discard_dialog.keep_editing')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelChangeSet}
              disabled={cancelingChangeSet}
            >
              {cancelingChangeSet ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {t('lease_review.discard_dialog.discard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unified Lock Confirmation Dialog — adapts copy by context.
          (a) Re-lock with staged edits: submits change set for approval + re-locks.
          (b) Initial activation: lifecycle → active, model_locked → true. */}

      {/* Controlled dialogs triggered from the More menu. Mount once at
          the page level so the menu items can open them without
          re-rendering the action bar. */}
      {isMasterLease && (
        <UploadAmendmentDialog
          parentLeaseId={lease.id}
          parentFilename={lease.filename}
          onSuccess={() => setAmendmentsRefresh(prev => prev + 1)}
          open={showAmendmentDialog}
          onOpenChange={setShowAmendmentDialog}
        />
      )}
      <ArchiveButton
        leaseId={lease.id}
        isArchived={!!lease.archived}
        onChange={refetchLease}
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
      />

      <Dialog open={lockConfirmDialogOpen} onOpenChange={setLockConfirmDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          {(() => {
            const isReLock = activeChangeSet?.status === 'draft' && stagedItemCount > 0;
            const isEmptyDraftRelock = activeChangeSet?.status === 'draft' && stagedItemCount === 0;
            const adminCanSelfApprove = isReLock && isAdminUser;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Lock className="h-5 w-5 text-success" />
                    {isReLock
                      ? t('lease_review.lock_dialog.submit_title', { count: stagedItemCount })
                      : isEmptyDraftRelock
                        ? t('lease_review.lock_dialog.lock_title')
                        : lifecycleStatus === 'executed' ? t('lease_review.lock_dialog.activate_title') : t('lease_review.lock_dialog.lock_title')}
                  </DialogTitle>
                  <DialogDescription>
                    {isReLock
                      ? adminCanSelfApprove
                        ? t('lease_review.lock_dialog.desc_self_approve')
                        : t('lease_review.lock_dialog.desc_submit')
                      : isEmptyDraftRelock
                        ? t('lease_review.lock_dialog.desc_empty_draft')
                        : t('lease_review.lock_dialog.desc_activate')}
                  </DialogDescription>
                </DialogHeader>
                {!isReLock && (
                  <ul className="text-xs text-muted-foreground space-y-1 ml-5 list-disc">
                    <li>{t('lease_review.lock_dialog.bullet_frozen')}</li>
                    <li>{t('lease_review.lock_dialog.bullet_status_prefix')} <strong>{t('lease_review.lock_dialog.bullet_status_active')}</strong></li>
                    <li>{t('lease_review.lock_dialog.bullet_dashboard')}</li>
                    <li>{t('lease_review.lock_dialog.bullet_lock_event')}</li>
                  </ul>
                )}
                {adminCanSelfApprove && (
                  <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
                    <p><strong className="text-foreground">{t('lease_review.lock_dialog.apply_label')}</strong> {t('lease_review.lock_dialog.apply_explain')}</p>
                    <p><strong className="text-foreground">{t('lease_review.lock_dialog.request_approval_label')}</strong> {t('lease_review.lock_dialog.request_approval_explain')}</p>
                  </div>
                )}
                {/* Approver picker for the Request Approval flow. Always shown
                    when there are staged edits, so admin AND member submitters
                    can target a specific reviewer. Falls back to the current
                    user as a single option if no other admins exist. */}
                {isReLock && (
                  <div className="space-y-1.5">
                    <Label htmlFor="approver-select" className="text-xs font-medium text-muted-foreground">
                      {approverCandidates.length === 1 && approverCandidates[0].id === user?.id
                        ? t('lease_review.lock_dialog.approver_label_self_only')
                        : t('lease_review.lock_dialog.approver_label')}
                    </Label>
                    <Select
                      value={selectedApproverId ?? undefined}
                      onValueChange={(v) => setSelectedApproverId(v)}
                    >
                      <SelectTrigger id="approver-select" className="h-9 text-sm">
                        <SelectValue placeholder={t('lease_review.lock_dialog.approver_placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {approverCandidates.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}{c.isOwner ? t('lease_review.lock_dialog.owner_suffix') : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                  {isReLock
                    ? t('lease_review.lock_dialog.warn_relock')
                    : t('lease_review.lock_dialog.warn_activate')}
                </div>
                <DialogFooter className="flex-col-reverse sm:flex-row gap-2 sm:gap-2 sm:flex-wrap sm:justify-end">
                  <Button variant="outline" onClick={() => setLockConfirmDialogOpen(false)} disabled={submittingChanges} className="sm:w-auto w-full">
                    {t('common.cancel')}
                  </Button>
                  {adminCanSelfApprove ? (
                    <>
                      <Button
                        variant="outline"
                        onClick={async () => {
                          await handleLockAction('approver', selectedApproverId);
                          setLockConfirmDialogOpen(false);
                        }}
                        disabled={submittingChanges || !selectedApproverId}
                        title={selectedApproverId
                          ? t('lease_review.lock_dialog.request_approval_title')
                          : t('lease_review.lock_dialog.pick_approver_first')}
                        className="sm:w-auto w-full whitespace-nowrap"
                      >
                        {t('lease_review.lock_dialog.request_approval_label')}
                      </Button>
                      <Button
                        className="bg-success hover:bg-success/90 text-white sm:w-auto w-full whitespace-nowrap"
                        onClick={async () => {
                          await handleLockAction('self_approve');
                          setLockConfirmDialogOpen(false);
                        }}
                        disabled={submittingChanges}
                        title={t('lease_review.lock_dialog.apply_title')}
                      >
                        {submittingChanges ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Lock className="h-4 w-4 mr-2" />}
                        {t('lease_review.lock_dialog.apply_label')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      className="bg-success hover:bg-success/90 text-white"
                      onClick={async () => {
                        // Members always go through the approver queue with
                        // the selected admin recipient.
                        // Empty-draft re-lock: handleLockAction routes to its
                        // cancel_change_set + relock branch (mode + approver
                        // ignored).
                        await handleLockAction('approver', selectedApproverId);
                        setLockConfirmDialogOpen(false);
                      }}
                      disabled={submittingChanges || (isReLock && !selectedApproverId)}
                      title={isReLock && !selectedApproverId
                        ? t('lease_review.lock_dialog.pick_approver_first')
                        : undefined}
                    >
                      {submittingChanges ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Lock className="h-4 w-4 mr-2" />}
                      {isReLock ? t('lease_review.header.submit_for_approval') : isEmptyDraftRelock ? t('lease_review.header.lock') : (lifecycleStatus === 'executed' ? t('lease_review.header.activate') : t('lease_review.header.lock'))}
                    </Button>
                  )}
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
      {workspace?.id && lease?.id && (
        <Tier2CorrectionDialog
          open={tier2CorrectionOpen}
          onOpenChange={setTier2CorrectionOpen}
          workspaceId={workspace.id}
          leaseId={lease.id}
          originalClassification={
            ((lease?.extracted_json as ExtractedJson | null) as any)?._tier2_classification ?? null
          }
          documentSummary={
            (() => {
              const ej = lease?.extracted_json as ExtractedJson | null;
              const fname = lease?.filename ?? lease?.request_title ?? null;
              const tenant = (ej as any)?.tenant_name ?? null;
              const tenantStr = typeof tenant === 'object' && tenant !== null ? (tenant as any)?.value : tenant;
              if (fname && tenantStr) return `${fname} — tenant: ${String(tenantStr).slice(0, 80)}`;
              return fname || null;
            })()
          }
        />
      )}
    </AppLayout>
  );
}
