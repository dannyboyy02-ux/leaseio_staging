import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";
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
  TrendingUp,
  Calendar,
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

  // Analyst Logic: Average Annual Increase Calculation
  const derivedInsights = useMemo(() => {
    const rawRent = form.base_rent_amount || "0";
    const startRent = parseFloat(rawRent.replace(/[^0-9.]/g, "")) || 0;

    if (!rentSchedule.length || startRent === 0 || !form.lease_end || !form.lease_start) {
      return { avgIncrease: "0.00", currentRent: startRent };
    }

    const endRent = rentSchedule[rentSchedule.length - 1].monthly_amount || startRent;
    const years = Math.max(1, new Date(form.lease_end).getFullYear() - new Date(form.lease_start).getFullYear());

    const totalIncreasePercent = ((endRent - startRent) / startRent) * 100;
    const avgAnnualIncrease = (totalIncreasePercent / years).toFixed(2);

    return { avgIncrease: avgAnnualIncrease, currentRent: startRent };
  }, [rentSchedule, form]);

  useEffect(() => {
    async function init() {
      if (!leaseId) return;
      const { data, error } = await supabase.from("leases").select("*").eq("id", leaseId).single();
      if (error) return;

      setLease(data);
      const ext = (data.extracted_json as ExtractedJson) || {};

      setForm({
        landlord_name: data.landlord_name || ext.landlord_name?.value || "",
        tenant_name: data.tenant_name || ext.tenant_name?.value || "",
        property_address: data.property_address || ext.property_address?.value || "",
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
  };

  const handleSync = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("leases")
        .update({ ...form })
        .eq("id", lease.id);
      if (error) throw error;
      toast.success("Lease records updated successfully");
    } catch (err) {
      toast.error("Update failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center font-sans text-slate-500">Initializing Cockpit...</div>
    );

  return (
    <AppLayout>
      <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-slate-50/50">
        <AppHeader
          title="Abstraction Cockpit"
          subtitle={lease.filename}
          action={
            <Button onClick={handleSync} disabled={saving} className="bg-blue-600 hover:bg-blue-700 shadow-sm">
              {saving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
              Sync Changes
            </Button>
          }
        />

        <div className="flex-1 px-6 pb-6 overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full rounded-xl border bg-white shadow-sm overflow-hidden"
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
              <div className="flex h-full flex-col bg-slate-100 relative">
                <div className="p-2 border-b flex justify-between bg-white items-center">
                  <span className="text-[10px] font-bold uppercase text-slate-400 px-2 tracking-tight">
                    Source Document
                  </span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsPdfCollapsed(true)}>
                    <ChevronLeft size={16} />
                  </Button>
                </div>
                {pdfUrl ? (
                  <iframe src={pdfUrl} className="w-full h-full border-none" title="Lease PDF" />
                ) : (
                  <div className="flex items-center justify-center h-full text-slate-400 text-sm">
                    Document stream unavailable
                  </div>
                )}
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle className="bg-slate-200 w-1 hover:bg-blue-400 transition-colors" />

            {/* Right Panel: Abstraction & Verification */}
            <ResizablePanel defaultSize={50} minSize={30}>
              <div className="flex h-full flex-col bg-white">
                <div className="p-2 border-b flex items-center bg-white">
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
                  <span className="text-[10px] font-bold uppercase text-slate-400 tracking-tight">
                    Review & Verification Panel
                  </span>
                </div>

                <ScrollArea className="flex-1 h-full">
                  <div className="p-6 space-y-6 max-w-2xl mx-auto">
                    {/* Card 1: Key Provisions */}
                    <Card className="shadow-none border-slate-200 overflow-hidden">
                      <CardHeader className="bg-slate-50/50 border-b pb-4">
                        <CardTitle className="text-sm font-bold flex items-center gap-2">
                          <FileText size={16} className="text-blue-600" /> Key Provisions
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-6 space-y-5">
                        {[
                          { id: "landlord_name", label: "Landlord", icon: Building2 },
                          { id: "property_address", label: "Premises Address", icon: Building2 },
                          { id: "base_rent_amount", label: "Current Monthly Rent", icon: DollarSign },
                          { id: "escalation_type", label: "Escalation Type", icon: Calculator },
                        ].map((field) => (
                          <div key={field.id} className="group">
                            <div className="flex items-center justify-between mb-1.5">
                              <Label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-2">
                                <field.icon size={12} className="text-slate-400" /> {field.label}
                                <Badge variant="outline" className="text-[9px] h-4 bg-slate-50 font-medium">
                                  {(lease?.extracted_json as ExtractedJson)?.[field.id as keyof ExtractedJson]
                                    ?.confidence || "Manual"}
                                </Badge>
                              </Label>
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-slate-400 hover:text-blue-600"
                                  title="Locate in PDF"
                                  onClick={() =>
                                    jumpToPage(
                                      (lease?.extracted_json as ExtractedJson)?.[field.id as keyof ExtractedJson]?.page,
                                    )
                                  }
                                >
                                  <Target size={12} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={cn(
                                    "h-6 w-6 transition-colors",
                                    verifiedFields.has(field.id)
                                      ? "text-green-600"
                                      : "text-slate-400 hover:text-green-600",
                                  )}
                                  onClick={() => {
                                    const n = new Set(verifiedFields);
                                    n.has(field.id) ? n.delete(field.id) : n.add(field.id);
                                    setVerifiedFields(n);
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
                                field.id === "escalation_type" ? `Calculated: ${derivedInsights.avgIncrease}%/yr` : ""
                              }
                              className={cn(
                                "text-sm transition-all focus-visible:ring-blue-500",
                                verifiedFields.has(field.id) && "border-green-200 bg-green-50/20",
                              )}
                            />
                          </div>
                        ))}
                      </CardContent>
                    </Card>

                    {/* Card 2: Corrected $ Rent Schedule with Highlights */}
                    <Card className="shadow-none border-slate-200 overflow-hidden">
                      <CardHeader className="bg-slate-50/50 border-b pb-4">
                        <CardTitle className="text-sm font-bold flex items-center gap-2">
                          <DollarSign size={16} className="text-green-600" /> $ Rent Schedule
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-6">
                        <div className="grid grid-cols-3 gap-3 mb-8">
                          <div className="p-3 rounded-lg bg-white border border-slate-200 shadow-sm">
                            <span className="text-[9px] uppercase font-bold text-slate-400 block mb-1">
                              Current Monthly Rent
                            </span>
                            <span className="text-md font-bold text-slate-900">
                              ${derivedInsights.currentRent.toLocaleString()}
                            </span>
                          </div>
                          <div className="p-3 rounded-lg bg-white border border-slate-200 shadow-sm">
                            <span className="text-[9px] uppercase font-bold text-slate-400 block mb-1 flex items-center gap-1">
                              <TrendingUp size={10} /> Escalation Type
                            </span>
                            <span className="text-xs font-semibold text-slate-700">
                              {form.escalation_type || `${derivedInsights.avgIncrease}% /yr`}
                            </span>
                          </div>
                          <div className="p-3 rounded-lg bg-white border border-slate-200 shadow-sm">
                            <span className="text-[9px] uppercase font-bold text-slate-400 block mb-1 flex items-center gap-1">
                              <Calendar size={10} /> Next Increase
                            </span>
                            <span className="text-xs font-semibold text-slate-700">
                              {rentSchedule.find((r) => new Date(r.period_start) > new Date())?.period_start
                                ? format(
                                    new Date(
                                      rentSchedule.find((r) => new Date(r.period_start) > new Date())!.period_start,
                                    ),
                                    "MMM yyyy",
                                  )
                                : "No Changes"}
                            </span>
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-100 overflow-hidden">
                          <RentScheduleTable rentSchedule={rentSchedule} />
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </ScrollArea>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </AppLayout>
  );
}
