import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  FileText,
  CheckCircle,
  Building2,
  DollarSign,
  Save,
  Loader2,
  Target,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Calculator,
  ExternalLink,
  Maximize2,
  Minimize2,
} from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";

// --- Interfaces ---
interface ExtractedField {
  value: any;
  page?: number;
  confidence: "low" | "medium" | "high";
}

interface ExtractedJson {
  property_address?: ExtractedField;
  landlord_name?: ExtractedField;
  tenant_name?: ExtractedField;
  lease_start?: ExtractedField;
  lease_end?: ExtractedField;
  base_rent_amount?: ExtractedField;
  escalation_type?: ExtractedField;
  rent_schedule?: Array<any>;
}

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const [lease, setLease] = useState<any | null>(null);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [basePdfUrl, setBasePdfUrl] = useState<string | null>(null);
  const [isPdfCollapsed, setIsPdfCollapsed] = useState(false);
  const [verifiedFields, setVerifiedFields] = useState<Set<string>>(new Set());

  const [form, setForm] = useState({
    landlord_name: "",
    tenant_name: "",
    property_address: "",
    lease_start: "",
    lease_end: "",
    base_rent_amount: "",
    escalation_type: "",
  });

  // --- Analyst Logic: Average Annual Increase ---
  const derivedInsights = useMemo(() => {
    if (!rentSchedule.length || !form.base_rent_amount) return null;

    const startRent = parseFloat(form.base_rent_amount.replace(/[^0-9.]/g, ""));
    const endRent = rentSchedule[rentSchedule.length - 1].monthly_amount || startRent;
    const years = Math.max(1, new Date(form.lease_end).getFullYear() - new Date(form.lease_start).getFullYear());

    const totalIncreasePercent = ((endRent - startRent) / startRent) * 100;
    const avgAnnualIncrease = (totalIncreasePercent / years).toFixed(2);

    return {
      avgIncrease: avgAnnualIncrease,
      isCalculated: !form.escalation_type,
    };
  }, [rentSchedule, form]);

  useEffect(() => {
    async function init() {
      if (!leaseId) return;
      const { data, error } = await supabase.from("leases").select("*").eq("id", leaseId).single();
      if (error) {
        toast.error("Lease not found");
        return;
      }

      setLease(data);
      const ext = (data.extracted_json as ExtractedJson) || {};

      setForm({
        landlord_name: data.landlord_name || ext.landlord_name?.value || "",
        tenant_name: data.tenant_name || ext.tenant_name?.value || "",
        property_address: ext.property_address?.value || "",
        lease_start: data.lease_start || ext.lease_start?.value || "",
        lease_end: data.lease_end || ext.lease_end?.value || "",
        base_rent_amount: data.base_rent_amount || ext.base_rent_amount?.value || "",
        escalation_type: ext.escalation_type?.value || "",
      });

      const { data: rs } = await supabase
        .from("rent_schedules")
        .select("*")
        .eq("lease_id", leaseId)
        .order("period_start");
      setRentSchedule(rs || []);

      if (data.storage_path) {
        const { data: urlData } = await supabase.storage.from("leases").createSignedUrl(data.storage_path, 3600);
        setPdfUrl(urlData?.signedUrl || null);
        setBasePdfUrl(urlData?.signedUrl || null);
      }
      setLoading(false);
    }
    init();
  }, [leaseId]);

  const jumpToPage = (page?: number) => {
    if (!page || !basePdfUrl) return;
    setPdfUrl(`${basePdfUrl}#page=${page}`);
    if (isPdfCollapsed) setIsPdfCollapsed(false);
    toast.info(`Jumping to page ${page}`);
  };

  const handleGlobalSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("leases")
        .update({
          ...form,
          updated_at: new Date().toISOString(),
        })
        .eq("id", lease.id);
      if (error) throw error;
      toast.success("Synced with Supabase Storage");
    } catch (err) {
      toast.error("Sync failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return <div className="flex h-screen items-center justify-center font-mono text-sm">LOADING ASSETS...</div>;

  return (
    <AppLayout>
      <AppHeader
        title="Lease Abstraction"
        subtitle={lease.filename}
        action={
          <Button onClick={handleGlobalSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
            {saving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
            Sync to Supabase
          </Button>
        }
      />

      <div className="px-6 pb-6 h-[calc(100vh-140px)]">
        <ResizablePanelGroup direction="horizontal" className="rounded-xl border shadow-sm overflow-hidden bg-white">
          {/* PDF PANEL */}
          <ResizablePanel
            defaultSize={50}
            collapsible={true}
            minSize={0}
            onCollapse={() => setIsPdfCollapsed(true)}
            onExpand={() => setIsPdfCollapsed(false)}
            className={cn(isPdfCollapsed && "min-w-0")}
          >
            <div className="flex h-full flex-col bg-slate-50 relative">
              <div className="p-3 border-b flex justify-between items-center bg-white">
                <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Source Evidence</span>
                <Button variant="ghost" size="icon" onClick={() => setIsPdfCollapsed(true)}>
                  <ChevronLeft size={18} />
                </Button>
              </div>
              {pdfUrl && <iframe src={pdfUrl} className="w-full h-full border-none" title="PDF Viewer" />}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* DATA COCKPIT PANEL */}
          <ResizablePanel defaultSize={50}>
            <div className="flex h-full flex-col">
              <div className="p-3 border-b flex items-center justify-between bg-white">
                <div className="flex items-center gap-2">
                  {isPdfCollapsed && (
                    <Button variant="ghost" size="icon" onClick={() => setIsPdfCollapsed(false)}>
                      <ChevronRight size={18} />
                    </Button>
                  )}
                  <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
                    Abstraction Cockpit
                  </span>
                </div>
                {derivedInsights && (
                  <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-100 flex gap-2">
                    <Calculator size={12} />
                    Avg Increase: {derivedInsights.avgIncrease}% /yr
                  </Badge>
                )}
              </div>

              <ScrollArea className="flex-1 p-6 bg-slate-50/30">
                <div className="max-w-2xl mx-auto space-y-6">
                  {/* Field Mapping */}
                  <Card className="border-slate-200 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">Key Provisions</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {[
                        { id: "landlord_name", label: "Landlord", icon: Building2 },
                        { id: "property_address", label: "Premises Address", icon: Building2 },
                        { id: "base_rent_amount", label: "Current Monthly Rent", icon: DollarSign },
                        { id: "escalation_type", label: "Escalation Type", icon: Calculator },
                      ].map((field) => (
                        <div key={field.id} className="group">
                          <div className="flex items-center justify-between mb-1">
                            <Label className="text-[11px] uppercase font-bold text-slate-400 flex items-center gap-2">
                              <field.icon size={12} /> {field.label}
                              <Badge variant="outline" className="text-[9px] h-4">
                                {(lease.extracted_json as ExtractedJson)?.[field.id as keyof ExtractedJson]
                                  ?.confidence || "Manual"}
                              </Badge>
                            </Label>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                                onClick={() => {
                                  const next = new Set(verifiedFields);
                                  next.has(field.id) ? next.delete(field.id) : next.add(field.id);
                                  setVerifiedFields(next);
                                }}
                              >
                                <ShieldCheck size={12} />
                              </Button>
                            </div>
                          </div>
                          <Input
                            value={(form as any)[field.id]}
                            onChange={(e) => setForm({ ...form, [field.id]: e.target.value })}
                            placeholder={
                              field.id === "escalation_type" && derivedInsights?.isCalculated
                                ? `Derived: ${derivedInsights.avgIncrease}%/yr`
                                : ""
                            }
                            className={cn(
                              "bg-white text-sm focus-visible:ring-blue-500",
                              verifiedFields.has(field.id) && "border-green-200 bg-green-50/20",
                            )}
                          />
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {/* Schedule */}
                  <Card className="border-slate-200 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">Rent Schedule</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <RentScheduleTable rentSchedule={rentSchedule} />
                    </CardContent>
                  </Card>
                </div>
              </ScrollArea>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </AppLayout>
  );
}
