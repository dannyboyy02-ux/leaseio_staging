import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { format, differenceInMonths } from "date-fns";
import {
  ArrowLeft,
  FileText,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Calendar,
  Building2,
  DollarSign,
  User,
  Download,
  Save,
  Loader2,
  Pencil,
  Check,
  X,
  Eye,
  RefreshCw,
  Clock,
  Banknote,
  Shield,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";
import { NotificationConfigurator } from "@/components/leases/NotificationConfigurator";
import { useApp } from "@/contexts/AppContext";
import { useLanguage } from "@/contexts/LanguageContext";

interface ExtractedJson {
  property_address?: string;
  security_deposit?: string;
  renewal_options?: string;
  escalation_clauses?: string;
  termination_clauses?: string;
  key_dates?: { date: string; description: string }[];
  current_monthly_rent?: number;
  rent_escalation_type?: string;
  rent_schedule?: Array<{
    period_start: string;
    period_end: string | null;
    monthly_amount: number | null;
    annual_amount: number | null;
    notes: string | null;
  }>;
}

interface LeaseData {
  id: string;
  filename: string;
  status: string;
  landlord_name: string | null;
  tenant_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  base_rent_amount: string | null;
  base_rent_frequency: string | null;
  current_monthly_rent: number | null;
  rent_escalation_type: string | null;
  extracted_json: ExtractedJson | null;
  uploaded_at: string;
  processed_at: string | null;
  storage_path: string | null;
}

interface Risk {
  id: string;
  title: string;
  severity: string;
  explanation: string | null;
  citation_snippet: string | null;
  citation_page: number | null;
}

interface EditableFields {
  filename: string;
  landlord_name: string;
  tenant_name: string;
  property_address: string;
  lease_start: string;
  lease_end: string;
  base_rent_amount: string;
  base_rent_frequency: string;
  security_deposit: string;
  renewal_options: string;
  escalation_clauses: string;
  termination_clauses: string;
}

type SectionKey = "parties" | "property" | "rent" | "financial" | "additional" | "document";

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useApp();
  const { t } = useLanguage();

  const [lease, setLease] = useState<LeaseData | null>(null);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [generatingSchedule, setGeneratingSchedule] = useState(false);

  const [confirmedSections, setConfirmedSections] = useState<Set<SectionKey>>(new Set());
  const [editingSections, setEditingSections] = useState<Set<SectionKey>>(new Set());
  const [editingFilename, setEditingFilename] = useState(false);
  const [savingFilename, setSavingFilename] = useState(false);

  // PDF Sheet state
  const [pdfSheetOpen, setPdfSheetOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(false);

  // ✅ Page-jump support (minimal additions)
  const [pdfPage, setPdfPage] = useState<number>(1);
  const [pendingPdfPage, setPendingPdfPage] = useState<number | null>(null);

  const [editableFields, setEditableFields] = useState<EditableFields>({
    filename: "",
    landlord_name: "",
    tenant_name: "",
    property_address: "",
    lease_start: "",
    lease_end: "",
    base_rent_amount: "",
    base_rent_frequency: "",
    security_deposit: "",
    renewal_options: "",
    escalation_clauses: "",
    termination_clauses: "",
  });

  const canEdit = hasPermission("leases");
  const isNeedsReview = lease?.status === "Ready" || lease?.status === "review";
  const isApproved = lease?.status === "Approved";

  // Hardened: Lock all inputs when lease is approved
  const isLocked = isApproved;

  // Hardened: Approve button validation - require landlord_name and lease_start
  const canApprove = !!(editableFields.landlord_name.trim() && editableFields.lease_start);

  // Calculate financial summary metrics
  const calculateLeaseTermMonths = (): number | null => {
    if (!editableFields.lease_start || !editableFields.lease_end) return null;
    try {
      const start = new Date(editableFields.lease_start);
      const end = new Date(editableFields.lease_end);
      return differenceInMonths(end, start);
    } catch {
      return null;
    }
  };

  const getInitialMonthlyRent = (): string => {
    // Try from rent schedule first
    if (rentSchedule.length > 0 && rentSchedule[0].monthly_amount) {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
        rentSchedule[0].monthly_amount,
      );
    }
    // Fall back to base_rent_amount
    if (editableFields.base_rent_amount) {
      // Check if it already looks like currency
      if (editableFields.base_rent_amount.startsWith("$")) {
        return editableFields.base_rent_amount;
      }
      const amount = parseFloat(editableFields.base_rent_amount.replace(/[^0-9.]/g, ""));
      if (!isNaN(amount)) {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
      }
    }
    return "—";
  };

  const getSecurityDeposit = (): string => {
    if (editableFields.security_deposit) {
      if (editableFields.security_deposit.startsWith("$")) {
        return editableFields.security_deposit;
      }
      const amount = parseFloat(editableFields.security_deposit.replace(/[^0-9.]/g, ""));
      if (!isNaN(amount)) {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
      }
      return editableFields.security_deposit;
    }
    return "—";
  };

  useEffect(() => {
    async function fetchLease() {
      if (!leaseId) return;

      try {
        const { data: leaseData, error: leaseError } = await supabase
          .from("leases")
          .select("*")
          .eq("id", leaseId)
          .single();

        if (leaseError) throw leaseError;

        const typedLease: LeaseData = {
          ...leaseData,
          extracted_json: leaseData.extracted_json as ExtractedJson | null,
          current_monthly_rent: leaseData.current_monthly_rent as number | null,
          rent_escalation_type: leaseData.rent_escalation_type as string | null,
        };
        setLease(typedLease);

        // Load confirmed sections from database
        const savedConfirmed = (leaseData.confirmed_sections as string[]) || [];
        setConfirmedSections(new Set(savedConfirmed as SectionKey[]));

        const extracted = typedLease.extracted_json || {};
        setEditableFields({
          filename: typedLease.filename || "",
          landlord_name: typedLease.landlord_name || "",
          tenant_name: typedLease.tenant_name || "",
          property_address: extracted.property_address || "",
          lease_start: typedLease.lease_start || "",
          lease_end: typedLease.lease_end || "",
          base_rent_amount: typedLease.base_rent_amount || "",
          base_rent_frequency: typedLease.base_rent_frequency || "",
          security_deposit: extracted.security_deposit || "",
          renewal_options: extracted.renewal_options || "",
          escalation_clauses: extracted.escalation_clauses || "",
          termination_clauses: extracted.termination_clauses || "",
        });

        const { data: risksData, error: risksError } = await supabase.from("risks").select("*").eq("lease_id", leaseId);

        if (risksError) throw risksError;
        setRisks(risksData || []);

        const { data: rentScheduleData, error: rentScheduleError } = await supabase
          .from("rent_schedules")
          .select("*")
          .eq("lease_id", leaseId)
          .order("period_start", { ascending: true });

        if (rentScheduleError) {
          console.error("Error fetching rent schedule:", rentScheduleError);
        } else {
          setRentSchedule(rentScheduleData || []);
        }
      } catch (error) {
        console.error("Error fetching lease:", error);
        toast.error("Failed to load lease");
      } finally {
        setLoading(false);
      }
    }

    fetchLease();
  }, [leaseId]);

  // ✅ If we had a pending page jump and the URL is ready, apply it
  useEffect(() => {
    if (pendingPdfPage && pdfUrl) {
      setPdfPage(pendingPdfPage);
      setPendingPdfPage(null);
    }
  }, [pendingPdfPage, pdfUrl]);

  const handleFieldChange = (field: keyof EditableFields, value: string) => {
    if (isLocked) return; // Prevent changes when locked
    setEditableFields((prev) => ({ ...prev, [field]: value }));
  };

  const handleConfirmSection = async (section: SectionKey) => {
    if (!lease || isLocked) return;

    const newConfirmed = new Set([...confirmedSections, section]);
    setConfirmedSections(newConfirmed);

    // Persist to database
    try {
      const { error } = await supabase
        .from("leases")
        .update({ confirmed_sections: Array.from(newConfirmed) })
        .eq("id", lease.id);

      if (error) throw error;
      toast.success(`${section} confirmed`);
    } catch (error) {
      console.error("Error confirming section:", error);
      toast.error("Failed to save confirmation");
      // Revert on error
      setConfirmedSections(confirmedSections);
    }
  };

  const handleSaveFilename = async () => {
    if (!lease || !editableFields.filename.trim() || isLocked) return;

    setSavingFilename(true);
    try {
      const { error } = await supabase
        .from("leases")
        .update({ filename: editableFields.filename.trim() })
        .eq("id", lease.id);

      if (error) throw error;

      setLease({ ...lease, filename: editableFields.filename.trim() });
      setEditingFilename(false);
      toast.success("Filename saved");
    } catch (error) {
      console.error("Error saving filename:", error);
      toast.error("Failed to save filename");
    } finally {
      setSavingFilename(false);
    }
  };

  const toggleEditSection = (section: SectionKey) => {
    if (isLocked) return; // Prevent editing when locked
    setEditingSections((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(section)) {
        newSet.delete(section);
      } else {
        newSet.add(section);
      }
      return newSet;
    });
  };

  const handleSave = async () => {
    if (!lease || isLocked) return;

    setSaving(true);
    try {
      const updatedExtractedJson: ExtractedJson = {
        ...(lease.extracted_json || {}),
        property_address: editableFields.property_address || undefined,
        security_deposit: editableFields.security_deposit || undefined,
        renewal_options: editableFields.renewal_options || undefined,
        escalation_clauses: editableFields.escalation_clauses || undefined,
        termination_clauses: editableFields.termination_clauses || undefined,
      };

      const { error } = await supabase
        .from("leases")
        .update({
          filename: editableFields.filename || lease.filename,
          landlord_name: editableFields.landlord_name || null,
          tenant_name: editableFields.tenant_name || null,
          lease_start: editableFields.lease_start || null,
          lease_end: editableFields.lease_end || null,
          base_rent_amount: editableFields.base_rent_amount || null,
          base_rent_frequency: editableFields.base_rent_frequency || null,
          extracted_json: JSON.parse(JSON.stringify(updatedExtractedJson)),
        })
        .eq("id", lease.id);

      if (error) throw error;

      setLease({
        ...lease,
        filename: editableFields.filename || lease.filename,
        landlord_name: editableFields.landlord_name || null,
        tenant_name: editableFields.tenant_name || null,
        lease_start: editableFields.lease_start || null,
        lease_end: editableFields.lease_end || null,
        base_rent_amount: editableFields.base_rent_amount || null,
        base_rent_frequency: editableFields.base_rent_frequency || null,
        extracted_json: updatedExtractedJson,
      });

      setEditingSections(new Set());
      setEditingFilename(false);
      toast.success("Lease saved successfully");
    } catch (error) {
      console.error("Error saving lease:", error);
      toast.error("Failed to save lease");
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    if (!lease || !canApprove) return;

    setApproving(true);
    try {
      // Get current user
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        toast.error("You must be logged in to approve");
        return;
      }

      const { error } = await supabase
        .from("leases")
        .update({
          status: "Approved",
          activated_at: new Date().toISOString(),
          lease_owner_id: user.id,
        })
        .eq("id", lease.id);

      if (error) throw error;

      setLease({ ...lease, status: "Approved" });
      toast.success("Lease approved and activated");
    } catch (error) {
      console.error("Error approving lease:", error);
      toast.error("Failed to approve lease");
    } finally {
      setApproving(false);
    }
  };

  const handleDownloadOriginal = async () => {
    if (!lease?.storage_path) {
      toast.error("Original file not available");
      return;
    }

    setDownloading(true);
    try {
      const { data, error } = await supabase.storage.from("leases").download(lease.storage_path);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = lease.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("Download started");
    } catch (error) {
      console.error("Error downloading file:", error);
      toast.error("Failed to download file");
    } finally {
      setDownloading(false);
    }
  };

  // ✅ Modified: use signed URL for viewer so we can do #page=
  const handleViewPdf = async () => {
    if (!lease?.storage_path) {
      toast.error("Original file not available");
      return;
    }

    setPdfSheetOpen(true);
    setLoadingPdf(true);

    try {
      // Create a short-lived signed URL (30 minutes)
      const { data, error } = await supabase.storage.from("leases").createSignedUrl(lease.storage_path, 60 * 30);

      if (error) throw error;

      setPdfUrl(data?.signedUrl || null);
    } catch (error) {
      console.error("Error loading PDF:", error);
      toast.error("Failed to load PDF");
      setPdfSheetOpen(false);
    } finally {
      setLoadingPdf(false);
    }
  };

  const handleClosePdfSheet = () => {
    setPdfSheetOpen(false);
    setPdfUrl(null);
    setPdfPage(1);
    setPendingPdfPage(null);
  };

  // ✅ New: jump to a specific page (used by citations)
  const jumpToPdfPage = async (page: number) => {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;

    setPdfPage(safePage);

    // Ensure viewer is open & URL is loaded
    if (!pdfSheetOpen) setPdfSheetOpen(true);

    if (!pdfUrl) {
      setPendingPdfPage(safePage);
      await handleViewPdf();
      return;
    }
  };

  const handleGenerateSchedule = async () => {
    if (!lease || !leaseId) return;

    const extractedSchedule = lease.extracted_json?.rent_schedule;
    if (!extractedSchedule || extractedSchedule.length === 0) {
      toast.error("No rent schedule found in extracted data");
      return;
    }

    setGeneratingSchedule(true);
    try {
      // Prepare data for upsert
      const scheduleRows = extractedSchedule.map((entry) => ({
        lease_id: leaseId,
        period_start: entry.period_start,
        period_end: entry.period_end,
        monthly_amount: entry.monthly_amount,
        annual_amount: entry.annual_amount,
        notes: entry.notes,
      }));

      // Delete existing schedules first, then insert new ones
      const { error: deleteError } = await supabase.from("rent_schedules").delete().eq("lease_id", leaseId);

      if (deleteError) throw deleteError;

      const { data: insertedData, error: insertError } = await supabase
        .from("rent_schedules")
        .insert(scheduleRows)
        .select();

      if (insertError) throw insertError;

      // Refresh the rent schedule table
      setRentSchedule(insertedData || []);
      toast.success(`Generated ${scheduleRows.length} rent schedule entries`);
    } catch (error) {
      console.error("Error generating schedule:", error);
      toast.error("Failed to generate rent schedule");
    } finally {
      setGeneratingSchedule(false);
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "high":
        return "bg-destructive/10 text-destructive border-destructive/20";
      case "medium":
        return "bg-yellow-500/10 text-yellow-600 border-yellow-500/20";
      case "low":
        return "bg-blue-500/10 text-blue-600 border-blue-500/20";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case "high":
        return <AlertCircle className="h-4 w-4" />;
      case "medium":
        return <AlertTriangle className="h-4 w-4" />;
      default:
        return <AlertTriangle className="h-4 w-4" />;
    }
  };

  const renderSectionHeader = (title: string, icon: React.ReactNode, section: SectionKey) => {
    const isEditing = editingSections.has(section);
    const isConfirmed = confirmedSections.has(section);
    const showConfirmButton = isNeedsReview && !isConfirmed && !isLocked;

    return (
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <div className="flex items-center gap-2">
          {showConfirmButton && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleConfirmSection(section)}
              className="text-green-600 border-green-600/30 hover:bg-green-600/10"
              disabled={isLocked}
            >
              <Check className="h-4 w-4 mr-1" />
              {t("lease.confirm")}
            </Button>
          )}
          {canEdit && !isLocked && (
            <Button variant="ghost" size="sm" onClick={() => toggleEditSection(section)} disabled={isLocked}>
              {isEditing ? (
                <>
                  <X className="h-4 w-4 mr-1" />
                  {t("common.cancel")}
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4 mr-1" />
                  {t("lease.edit")}
                </>
              )}
            </Button>
          )}
        </div>
      </CardHeader>
    );
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (!lease) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
          <FileText className="h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">Lease not found</p>
          <Button variant="outline" onClick={() => navigate("/app/leases")}>
            {t("lease.back")} to Leases
          </Button>
        </div>
      </AppLayout>
    );
  }

  const leaseTermMonths = calculateLeaseTermMonths();

  return (
    <AppLayout>
      <AppHeader
        title={t("lease.review")}
        subtitle={lease.filename}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate("/app/leases")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              {t("lease.back")}
            </Button>
            <Button variant="outline" onClick={handleViewPdf} disabled={!lease.storage_path}>
              <Eye className="h-4 w-4 mr-2" />
              View Original PDF
            </Button>
            <Button variant="outline" onClick={handleSave} disabled={saving || isLocked}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              {t("lease.save")}
            </Button>
          </div>
        }
      />

      {/* PDF Sheet Viewer */}
      <Sheet open={pdfSheetOpen} onOpenChange={handleClosePdfSheet}>
        <SheetContent side="right" className="w-full sm:max-w-2xl lg:max-w-4xl p-0">
          <SheetHeader className="p-4 border-b">
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {lease.filename}
            </SheetTitle>
            <SheetDescription>Original lease document {pdfPage ? `• Page ${pdfPage}` : ""}</SheetDescription>
          </SheetHeader>
          <div className="h-[calc(100vh-100px)] overflow-hidden">
            {loadingPdf ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : pdfUrl ? (
              <iframe
                // ✅ Page jump via URL fragment
                src={`${pdfUrl}#page=${pdfPage}`}
                className="w-full h-full border-0"
                title="Lease PDF"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">Failed to load PDF</div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <div className="p-6 space-y-6">
        {/* Status Banner */}
        {isNeedsReview && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
            <div>
              <p className="font-medium text-yellow-600">{t("lease.review_required")}</p>
              <p className="text-sm text-muted-foreground">{t("lease.review_edit_info")}</p>
            </div>
          </div>
        )}

        {isApproved && (
          <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4 flex items-start gap-3">
            <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
            <div>
              <p className="font-medium text-green-600">
                {t("lease.approved")} - {t("lease.active")}
              </p>
              <p className="text-sm text-muted-foreground">{t("lease.approved_info")}</p>
            </div>
          </div>
        )}

        {/* Financial Summary Card - At the very top */}
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-primary" />
              Financial Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-background/80 border">
                <div className="p-2 rounded-full bg-primary/10">
                  <Clock className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Total Lease Term</p>
                  <p className="text-lg font-semibold">
                    {leaseTermMonths !== null ? `${leaseTermMonths} months` : "—"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-background/80 border">
                <div className="p-2 rounded-full bg-primary/10">
                  <Banknote className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Initial Monthly Rent</p>
                  <p className="text-lg font-semibold">{getInitialMonthlyRent()}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-background/80 border">
                <div className="p-2 rounded-full bg-primary/10">
                  <Shield className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Security Deposit</p>
                  <p className="text-lg font-semibold">{getSecurityDeposit()}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Parties */}
            <Card>
              {renderSectionHeader(t("lease.parties"), <User className="h-5 w-5" />, "parties")}
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="landlord_name">{t("lease.landlord")}</Label>
                  <Input
                    id="landlord_name"
                    value={editableFields.landlord_name}
                    onChange={(e) => handleFieldChange("landlord_name", e.target.value)}
                    placeholder="Landlord name"
                    disabled={!editingSections.has("parties") || isLocked}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tenant_name">{t("lease.tenant")}</Label>
                  <Input
                    id="tenant_name"
                    value={editableFields.tenant_name}
                    onChange={(e) => handleFieldChange("tenant_name", e.target.value)}
                    placeholder="Tenant name"
                    disabled={!editingSections.has("parties") || isLocked}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Property & Term */}
            <Card>
              {renderSectionHeader(t("lease.property_term"), <Building2 className="h-5 w-5" />, "property")}
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="property_address">{t("lease.property_address")}</Label>
                  <Input
                    id="property_address"
                    value={editableFields.property_address}
                    onChange={(e) => handleFieldChange("property_address", e.target.value)}
                    placeholder="Full property address"
                    disabled={!editingSections.has("property") || isLocked}
                  />
                </div>
                <Separator />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="lease_start" className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      {t("lease.commencement_date")}
                    </Label>
                    <Input
                      id="lease_start"
                      type="date"
                      value={editableFields.lease_start}
                      onChange={(e) => handleFieldChange("lease_start", e.target.value)}
                      disabled={!editingSections.has("property") || isLocked}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lease_end" className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      {t("lease.expiration_date")}
                    </Label>
                    <Input
                      id="lease_end"
                      type="date"
                      value={editableFields.lease_end}
                      onChange={(e) => handleFieldChange("lease_end", e.target.value)}
                      disabled={!editingSections.has("property") || isLocked}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Rent Schedule with Generate Button */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div /> {/* Spacer */}
                {!isLocked && lease.extracted_json?.rent_schedule && lease.extracted_json.rent_schedule.length > 0 && (
                  <Button variant="outline" size="sm" onClick={handleGenerateSchedule} disabled={generatingSchedule}>
                    {generatingSchedule ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Generate Schedule
                  </Button>
                )}
              </div>
              <RentScheduleTable
                rentSchedule={rentSchedule}
                currentMonthlyRent={lease.current_monthly_rent}
                rentEscalationType={lease.rent_escalation_type}
              />
            </div>

            {/* Additional Financial Terms */}
            <Card>
              {renderSectionHeader(t("lease.financial_terms"), <DollarSign className="h-5 w-5" />, "financial")}
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="base_rent_amount">{t("lease.base_rent")}</Label>
                  <Input
                    id="base_rent_amount"
                    value={editableFields.base_rent_amount}
                    onChange={(e) => handleFieldChange("base_rent_amount", e.target.value)}
                    placeholder="e.g., $5,000"
                    disabled={!editingSections.has("financial") || isLocked}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="base_rent_frequency">{t("lease.rent_frequency")}</Label>
                  <Input
                    id="base_rent_frequency"
                    value={editableFields.base_rent_frequency}
                    onChange={(e) => handleFieldChange("base_rent_frequency", e.target.value)}
                    placeholder="e.g., monthly, annually"
                    disabled={!editingSections.has("financial") || isLocked}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="security_deposit">{t("lease.security_deposit")}</Label>
                  <Input
                    id="security_deposit"
                    value={editableFields.security_deposit}
                    onChange={(e) => handleFieldChange("security_deposit", e.target.value)}
                    placeholder="e.g., $10,000"
                    disabled={!editingSections.has("financial") || isLocked}
                  />
                </div>
                <div className="sm:col-span-2 space-y-2">
                  <Label htmlFor="escalation_clauses">{t("lease.escalation_clauses")}</Label>
                  <Textarea
                    id="escalation_clauses"
                    value={editableFields.escalation_clauses}
                    onChange={(e) => handleFieldChange("escalation_clauses", e.target.value)}
                    placeholder="Summary of rent escalation terms"
                    rows={3}
                    disabled={!editingSections.has("financial") || isLocked}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Additional Terms */}
            <Card>
              {renderSectionHeader(t("lease.additional_terms"), null, "additional")}
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="renewal_options">{t("lease.renewal_options")}</Label>
                  <Textarea
                    id="renewal_options"
                    value={editableFields.renewal_options}
                    onChange={(e) => handleFieldChange("renewal_options", e.target.value)}
                    placeholder="Summary of renewal options"
                    rows={3}
                    disabled={!editingSections.has("additional") || isLocked}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="termination_clauses">{t("lease.termination_clauses")}</Label>
                  <Textarea
                    id="termination_clauses"
                    value={editableFields.termination_clauses}
                    onChange={(e) => handleFieldChange("termination_clauses", e.target.value)}
                    placeholder="Summary of termination provisions"
                    rows={3}
                    disabled={!editingSections.has("additional") || isLocked}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Key Dates & Notifications - removed confirmation from here */}
            <NotificationConfigurator
              leaseId={lease.id}
              leaseStart={editableFields.lease_start}
              leaseEnd={editableFields.lease_end}
              rentSchedule={rentSchedule.map((rs) => ({
                period_start: rs.period_start,
                monthly_amount: rs.monthly_amount,
              }))}
            />

            {/* Approve Button */}
            {isNeedsReview && canEdit && !isLocked && (
              <div className="pt-4">
                <Button
                  variant="accent"
                  size="lg"
                  className="w-full"
                  onClick={handleApprove}
                  disabled={approving || !canApprove}
                  title={!canApprove ? "Landlord name and lease start date are required" : undefined}
                >
                  {approving ? (
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle className="h-5 w-5 mr-2" />
                  )}
                  {t("lease.approve")}
                </Button>
                {!canApprove && (
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    Landlord name and lease start date are required to approve
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Document Info */}
            <Card>
              {renderSectionHeader(t("lease.document"), null, "document")}
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <FileText className="h-8 w-8 text-primary" />
                  <div className="flex-1 min-w-0">
                    {(editingFilename || editingSections.has("document")) && !isLocked ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={editableFields.filename}
                          onChange={(e) => handleFieldChange("filename", e.target.value)}
                          className="text-sm font-medium flex-1"
                          placeholder="Filename"
                          disabled={isLocked}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveFilename();
                            if (e.key === "Escape") {
                              setEditableFields((prev) => ({ ...prev, filename: lease.filename }));
                              setEditingFilename(false);
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          onClick={handleSaveFilename}
                          disabled={savingFilename || !editableFields.filename.trim() || isLocked}
                        >
                          {savingFilename ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditableFields((prev) => ({ ...prev, filename: lease.filename }));
                            setEditingFilename(false);
                          }}
                          disabled={isLocked}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <div
                        className={cn("flex items-center gap-2 group", canEdit && !isLocked && "cursor-pointer")}
                        onClick={() => canEdit && !isLocked && setEditingFilename(true)}
                      >
                        <p className="text-sm font-medium truncate">{lease.filename}</p>
                        {canEdit && !isLocked && (
                          <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Uploaded {format(new Date(lease.uploaded_at), "MMM d, yyyy")}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleDownloadOriginal}
                  disabled={downloading || !lease.storage_path}
                >
                  {downloading ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4 mr-1" />
                  )}
                  {t("lease.download_original")}
                </Button>
              </CardContent>
            </Card>

            {/* Risks */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center justify-between">
                  <span>{t("lease.identified_risks")}</span>
                  <Badge variant="outline">{risks.length}</Badge>
                </CardTitle>
                <CardDescription>{t("lease.ai_risks_desc")}</CardDescription>
              </CardHeader>
              <CardContent>
                {risks.length === 0 ? (
                  <div className="text-center py-6">
                    <CheckCircle className="h-8 w-8 text-green-500 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">{t("lease.no_risks")}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {risks.map((risk) => (
                      <div key={risk.id} className={cn("p-3 rounded-lg border", getSeverityColor(risk.severity))}>
                        <div className="flex items-start gap-2">
                          {getSeverityIcon(risk.severity)}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{risk.title}</p>
                            {risk.explanation && <p className="text-xs mt-1 opacity-80">{risk.explanation}</p>}
                            {risk.citation_page && (
                              <button
                                type="button"
                                className="text-xs mt-1 opacity-80 underline underline-offset-2 hover:opacity-100"
                                onClick={() => jumpToPdfPage(risk.citation_page!)}
                                title="Open PDF at cited page"
                              >
                                {t("common.page")} {risk.citation_page}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Status */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t("lease.status")}</CardTitle>
              </CardHeader>
              <CardContent>
                <Badge variant={isApproved ? "default" : "secondary"} className="capitalize">
                  {isApproved ? t("lease.active") : lease.status}
                </Badge>
                {lease.processed_at && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Processed {format(new Date(lease.processed_at), "MMM d, yyyy h:mm a")}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
