import { useEffect, useMemo, useState } from "react";
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
  RefreshCw,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";
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

  // Document-first PDF URL (signed)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(false);

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

  const getInitialMonthlyRentNumber = (): number | null => {
    if (rentSchedule.length > 0 && typeof rentSchedule[0].monthly_amount === "number") {
      return rentSchedule[0].monthly_amount ?? null;
    }
    if (editableFields.base_rent_amount) {
      const amount = parseFloat(editableFields.base_rent_amount.replace(/[^0-9.]/g, ""));
      if (!isNaN(amount)) return amount;
    }
    return null;
  };

  const formatCurrency = (n: number | null): string => {
    if (n === null || typeof n !== "number" || Number.isNaN(n)) return "—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
  };

  const leaseTermMonths = useMemo(
    () => calculateLeaseTermMonths(),
    [editableFields.lease_start, editableFields.lease_end],
  );

  const totalCommitment = useMemo(() => {
    const m = leaseTermMonths;
    const initial = getInitialMonthlyRentNumber();
    if (m === null || initial === null) return null;
    // Simple deterministic roll-up (not accounting). Display-only.
    return m * initial;
  }, [leaseTermMonths, rentSchedule, editableFields.base_rent_amount]);

  const nextIncrease = useMemo(() => {
    if (!rentSchedule || rentSchedule.length < 2) return null;
    const first = rentSchedule[0]?.monthly_amount ?? null;
    if (first === null) return null;

    for (let i = 1; i < rentSchedule.length; i++) {
      const amt = rentSchedule[i]?.monthly_amount ?? null;
      if (amt !== null && amt !== first) {
        return {
          date: rentSchedule[i].period_start,
          amount: amt,
        };
      }
    }
    return null;
  }, [rentSchedule]);

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

  // Generate signed PDF URL for iframe (document-first)
  useEffect(() => {
    async function loadPdf() {
      if (!lease?.storage_path) {
        setPdfUrl(null);
        return;
      }

      setLoadingPdf(true);
      try {
        // Use a signed URL so iframe can load it reliably
        const { data, error } = await supabase.storage.from("leases").createSignedUrl(lease.storage_path, 60 * 60);

        if (error) throw error;
        setPdfUrl(data?.signedUrl ?? null);
      } catch (error) {
        console.error("Error creating signed PDF URL:", error);
        setPdfUrl(null);
      } finally {
        setLoadingPdf(false);
      }
    }

    loadPdf();
  }, [lease?.storage_path]);

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
      if (newSet.has(section)) newSet.delete(section);
      else newSet.add(section);
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

  const rightPanelHeightClass = "h-[calc(100vh-84px)]"; // conservative header offset; matches typical AppHeader height

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
            <Button variant="outline" onClick={handleDownloadOriginal} disabled={downloading || !lease.storage_path}>
              {downloading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              {t("lease.download_original")}
            </Button>
          </div>
        }
      />

      {/* Split View */}
      <div className={cn("px-6 pb-6", rightPanelHeightClass)}>
        <ResizablePanelGroup direction="horizontal" className="h-full rounded-lg border bg-background">
          {/* Left: PDF */}
          <ResizablePanel defaultSize={50} minSize={30}>
            <div className="h-full flex flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium truncate">{lease.filename}</p>
                </div>
                <Badge variant="outline" className="capitalize">
                  {isApproved ? t("lease.active") : lease.status}
                </Badge>
              </div>

              <div className="flex-1 overflow-hidden">
                {loadingPdf ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : pdfUrl ? (
                  <iframe src={pdfUrl} className="w-full h-full border-0" title="Lease PDF" />
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">No document found</div>
                )}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Right: Review */}
          <ResizablePanel defaultSize={50} minSize={35}>
            <div className="h-full flex flex-col">
              {/* Status banners stay but are slim and above scroll */}
              <div className="px-4 pt-4">
                {isNeedsReview && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                    <div>
                      <p className="font-medium text-yellow-600">{t("lease.review_required")}</p>
                      <p className="text-sm text-muted-foreground">{t("lease.review_edit_info")}</p>
                    </div>
                  </div>
                )}

                {isApproved && (
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 flex items-start gap-3">
                    <CheckCircle className="h-5 w-5 text-green-600 mt-0.5" />
                    <div>
                      <p className="font-medium text-green-600">
                        {t("lease.approved")} - {t("lease.active")}
                      </p>
                      <p className="text-sm text-muted-foreground">{t("lease.approved_info")}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Scrollable content */}
              <ScrollArea className="flex-1 px-4 pb-4">
                <div className="pt-4 space-y-4">
                  {/* Financial Summary Ribbon (slim) */}
                  <div className="rounded-lg border bg-muted/30 px-4 py-3">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <p className="text-xs text-muted-foreground">Term</p>
                        <p className="text-sm font-semibold">
                          {leaseTermMonths !== null ? `${leaseTermMonths} months` : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Total Commitment</p>
                        <p className="text-sm font-semibold">{formatCurrency(totalCommitment)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Next Increase</p>
                        <p className="text-sm font-semibold">
                          {nextIncrease
                            ? `${format(new Date(nextIncrease.date), "MMM d, yyyy")} • ${formatCurrency(nextIncrease.amount)}`
                            : "—"}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Property & Term (includes Parties) */}
                  <Card>
                    {renderSectionHeader(t("lease.property_term"), <Building2 className="h-5 w-5" />, "property")}
                    <CardContent className="space-y-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="landlord_name">{t("lease.landlord")}</Label>
                          <Input
                            id="landlord_name"
                            value={editableFields.landlord_name}
                            onChange={(e) => handleFieldChange("landlord_name", e.target.value)}
                            placeholder="Landlord name"
                            disabled={!editingSections.has("property") || isLocked}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="tenant_name">{t("lease.tenant")}</Label>
                          <Input
                            id="tenant_name"
                            value={editableFields.tenant_name}
                            onChange={(e) => handleFieldChange("tenant_name", e.target.value)}
                            placeholder="Tenant name"
                            disabled={!editingSections.has("property") || isLocked}
                          />
                        </div>
                      </div>

                      <Separator />

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

                  {/* Rent Schedule Card with header button */}
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <div>
                        <CardTitle className="text-lg flex items-center gap-2">
                          <DollarSign className="h-5 w-5" />
                          Rent Schedule
                        </CardTitle>
                        <CardDescription>
                          Review schedule outputs. “Generate Schedule” uses extracted rent schedule when available.
                        </CardDescription>
                      </div>

                      {!isLocked &&
                        lease.extracted_json?.rent_schedule &&
                        lease.extracted_json.rent_schedule.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleGenerateSchedule}
                            disabled={generatingSchedule}
                          >
                            {generatingSchedule ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4 mr-2" />
                            )}
                            Generate Schedule
                          </Button>
                        )}
                    </CardHeader>

                    <CardContent>
                      <RentScheduleTable
                        rentSchedule={rentSchedule}
                        currentMonthlyRent={lease.current_monthly_rent}
                        rentEscalationType={lease.rent_escalation_type}
                      />
                    </CardContent>
                  </Card>

                  {/* spacer so content doesn't hide behind sticky bar */}
                  <div className="h-20" />
                </div>
              </ScrollArea>

              {/* Sticky Action Bar */}
              <div className="sticky bottom-0 border-t bg-background/95 backdrop-blur px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  {/* Filename inline edit retained (compact) */}
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-muted-foreground hidden sm:inline">File</span>
                    {(editingFilename || editingSections.has("document")) && !isLocked ? (
                      <div className="flex items-center gap-2 min-w-0">
                        <Input
                          value={editableFields.filename}
                          onChange={(e) => handleFieldChange("filename", e.target.value)}
                          className="h-8 text-sm font-medium w-[260px] max-w-[55vw]"
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
                          className="h-8"
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
                          className="h-8"
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
                      <button
                        type="button"
                        className={cn(
                          "text-sm font-medium truncate text-left hover:underline max-w-[320px]",
                          canEdit && !isLocked ? "cursor-pointer" : "cursor-default",
                        )}
                        onClick={() => canEdit && !isLocked && setEditingFilename(true)}
                        title={lease.filename}
                      >
                        {lease.filename}
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={handleSave}
                      disabled={saving || isLocked}
                      className="min-w-[120px]"
                    >
                      {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                      Save Draft
                    </Button>

                    {isNeedsReview && canEdit && !isLocked && (
                      <Button
                        variant="accent"
                        onClick={handleApprove}
                        disabled={approving || !canApprove}
                        className="min-w-[120px]"
                        title={!canApprove ? "Landlord name and lease start date are required" : undefined}
                      >
                        {approving ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <CheckCircle className="h-4 w-4 mr-2" />
                        )}
                        {t("lease.approve")}
                      </Button>
                    )}
                  </div>
                </div>

                {!canApprove && isNeedsReview && canEdit && !isLocked && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Landlord name and lease start date are required to approve
                  </p>
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </AppLayout>
  );
}
