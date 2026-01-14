import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { format, differenceInMonths } from "date-fns";
import {
  ArrowLeft,
  FileText,
  CheckCircle,
  AlertTriangle,
  Calendar,
  Building2,
  DollarSign,
  Download,
  Save,
  Loader2,
  Pencil,
  Check,
  X,
  RefreshCw,
  Target,
  ShieldCheck,
} from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";
import { useApp } from "@/contexts/AppContext";
import { useLanguage } from "@/contexts/LanguageContext";

// --- Types & Interfaces ---
interface ExtractedField {
  value: any;
  page?: number;
  confidence: "low" | "medium" | "high";
  verified?: boolean;
}

interface ExtractedJson {
  property_address?: ExtractedField;
  landlord_name?: ExtractedField;
  tenant_name?: ExtractedField;
  lease_start?: ExtractedField;
  lease_end?: ExtractedField;
  base_rent_amount?: ExtractedField;
  rent_schedule?: Array<{
    period_start: string;
    period_end: string | null;
    monthly_amount: number | null;
    page?: number;
    confidence: "low" | "medium" | "high";
  }>;
}

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useApp();
  const { t } = useLanguage();

  const [lease, setLease] = useState<any | null>(null);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [basePdfUrl, setBasePdfUrl] = useState<string | null>(null);
  const [verifiedFields, setVerifiedFields] = useState<Set<string>>(new Set());

  const [editableFields, setEditableFields] = useState({
    filename: "",
    landlord_name: "",
    tenant_name: "",
    property_address: "",
    lease_start: "",
    lease_end: "",
    base_rent_amount: "",
  });

  const isApproved = lease?.status === "Approved";
  const isLocked = isApproved;
  const canEdit = hasPermission("leases");

  // --- Logic: Jump to Page ---
  const jumpToPage = (pageNumber?: number) => {
    if (!pageNumber || !basePdfUrl) return;
    setPdfUrl(`${basePdfUrl}#page=${pageNumber}`);
    toast.info(`Jumping to page ${pageNumber}`);
  };

  const toggleVerify = (fieldName: string) => {
    const newVerified = new Set(verifiedFields);
    if (newVerified.has(fieldName)) newVerified.delete(fieldName);
    else newVerified.add(fieldName);
    setVerifiedFields(newVerified);
  };

  // --- Accuracy Badge Component ---
  const AccuracyBadge = ({ level, field }: { level?: "low" | "medium" | "high"; field: string }) => {
    if (!level) return null;
    const isVerified = verifiedFields.has(field);

    return (
      <div className="flex items-center gap-1">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] uppercase px-1 py-0 h-4",
            isVerified
              ? "bg-green-100 text-green-700 border-green-200"
              : level === "low"
                ? "bg-red-100 text-red-700 border-red-200"
                : level === "medium"
                  ? "bg-yellow-100 text-yellow-700 border-yellow-200"
                  : "bg-blue-100 text-blue-700 border-blue-200",
          )}
        >
          {isVerified ? "Verified" : `${level} Accuracy`}
        </Badge>
      </div>
    );
  };

  useEffect(() => {
    async function fetchLease() {
      if (!leaseId) return;
      try {
        const { data, error } = await supabase.from("leases").select("*").eq("id", leaseId).single();
        if (error) throw error;

        setLease(data);
        const ext = (data.extracted_json as ExtractedJson) || {};

        setEditableFields({
          filename: data.filename || "",
          landlord_name: data.landlord_name || ext.landlord_name?.value || "",
          tenant_name: data.tenant_name || ext.tenant_name?.value || "",
          property_address: ext.property_address?.value || "",
          lease_start: data.lease_start || ext.lease_start?.value || "",
          lease_end: data.lease_end || ext.lease_end?.value || "",
          base_rent_amount: data.base_rent_amount || ext.base_rent_amount?.value || "",
        });

        const { data: rs } = await supabase
          .from("rent_schedules")
          .select("*")
          .eq("lease_id", leaseId)
          .order("period_start");
        setRentSchedule(rs || []);

        // Load PDF
        if (data.storage_path) {
          const { data: urlData } = await supabase.storage.from("leases").createSignedUrl(data.storage_path, 3600);
          setPdfUrl(urlData?.signedUrl || null);
          setBasePdfUrl(urlData?.signedUrl || null);
        }
      } catch (err) {
        toast.error("Failed to load lease");
      } finally {
        setLoading(false);
      }
    }
    fetchLease();
  }, [leaseId]);

  const handleSave = async () => {
    if (isLocked) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("leases")
        .update({
          ...editableFields,
          status: "review",
        })
        .eq("id", lease.id);
      if (error) throw error;
      toast.success("Draft Saved");
    } catch (err) {
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      await supabase
        .from("leases")
        .update({
          status: "Approved",
          lease_owner_id: user?.id,
          activated_at: new Date().toISOString(),
        })
        .eq("id", lease.id);
      setLease({ ...lease, status: "Approved" });
      toast.success("Lease Approved & Locked");
    } catch (err) {
      toast.error("Approval failed");
    } finally {
      setApproving(false);
    }
  };

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );

  return (
    <AppLayout>
      <AppHeader title="Lease Review" subtitle={editableFields.filename} />
      <div className="px-6 pb-6 h-[calc(100vh-120px)]">
        <ResizablePanelGroup direction="horizontal" className="rounded-xl border bg-card">
          {/* Left: Document View */}
          <ResizablePanel defaultSize={50}>
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between p-3 border-b bg-muted/20">
                <span className="text-sm font-medium flex items-center gap-2">
                  <FileText size={16} /> Source Document
                </span>
                <Badge variant={isApproved ? "success" : "outline"}>{lease.status}</Badge>
              </div>
              {pdfUrl ? (
                <iframe src={pdfUrl} className="w-full h-full" />
              ) : (
                <div className="p-10 text-center">No PDF available</div>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Right: Data Cockpit */}
          <ResizablePanel defaultSize={50}>
            <div className="flex h-full flex-col">
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-6">
                  {/* Property & Parties Card */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-md">Property & Parties</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {[
                        { id: "landlord_name", label: "Landlord", icon: Building2 },
                        { id: "tenant_name", label: "Tenant", icon: Building2 },
                        { id: "property_address", label: "Address", icon: Building2 },
                      ].map((field) => (
                        <div key={field.id} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <Label className="flex items-center gap-2 text-xs font-semibold">
                              <field.icon size={14} className="text-muted-foreground" />
                              {field.label}
                              <AccuracyBadge
                                field={field.id}
                                level={
                                  (lease.extracted_json as ExtractedJson)?.[field.id as keyof ExtractedJson]?.confidence
                                }
                              />
                            </Label>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6"
                                onClick={() =>
                                  jumpToPage(
                                    (lease.extracted_json as ExtractedJson)?.[field.id as keyof ExtractedJson]?.page,
                                  )
                                }
                              >
                                <Target size={12} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn("h-6 w-6", verifiedFields.has(field.id) && "text-green-600")}
                                onClick={() => toggleVerify(field.id)}
                              >
                                <ShieldCheck size={12} />
                              </Button>
                            </div>
                          </div>
                          <Input
                            value={(editableFields as any)[field.id]}
                            onChange={(e) => setEditableFields({ ...editableFields, [field.id]: e.target.value })}
                            disabled={isLocked}
                            className={cn(verifiedFields.has(field.id) && "border-green-200 bg-green-50/30")}
                          />
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {/* Rent Schedule Card */}
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                      <CardTitle className="text-md flex items-center gap-2">
                        <DollarSign size={16} /> Rent Schedule
                      </CardTitle>
                      {!isLocked && (
                        <Button variant="outline" size="sm" onClick={() => toast.info("Refreshing...")}>
                          <RefreshCw size={14} className="mr-2" /> Regenerate
                        </Button>
                      )}
                    </CardHeader>
                    <CardContent>
                      <RentScheduleTable rentSchedule={rentSchedule} />
                    </CardContent>
                  </Card>
                </div>
              </ScrollArea>

              {/* Action Footer */}
              <div className="p-4 border-t bg-background flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Input
                    value={editableFields.filename}
                    onChange={(e) => setEditableFields({ ...editableFields, filename: e.target.value })}
                    className="w-48 h-8 text-xs"
                    disabled={isLocked}
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleSave} disabled={saving || isLocked}>
                    {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} className="mr-2" />} Save
                    Draft
                  </Button>
                  {!isLocked && (
                    <Button
                      variant="default"
                      size="sm"
                      className="bg-green-600 hover:bg-green-700"
                      onClick={handleApprove}
                      disabled={approving}
                    >
                      {approving ? (
                        <Loader2 className="animate-spin" size={14} />
                      ) : (
                        <CheckCircle size={14} className="mr-2" />
                      )}{" "}
                      Approve & Lock
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </AppLayout>
  );
}
