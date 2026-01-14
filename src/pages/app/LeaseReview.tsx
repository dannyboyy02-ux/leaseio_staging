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

  // --- Analyst Logic: Average Annual Increase ---
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

    return {
      avgIncrease: avgAnnualIncrease,
      currentRent: startRent,
    };
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
        property_address: data.property_address || ext.property_address?.value || "", // Fix for Light Blue
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
      toast.success("Lease data synced to Supabase");
    } catch (err) {
      toast.error("Sync failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex h-screen items-center justify-center">Loading Abstraction...</div>;

  return (
    <AppLayout>
      <AppHeader
        title="Abstraction Cockpit"
        subtitle={lease.filename}
        action={
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-100">
              Avg Increase: {derivedInsights.avgIncrease}% /yr
            </Badge>
            <Button onClick={handleSync} disabled={saving} className="bg-blue-600">
              {saving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
              Sync Changes
            </Button>
          </div>
        }
      />

      <div className="px-6 pb-6 h-[calc(100vh-140px)]">
        <ResizablePanelGroup direction="horizontal" className="rounded-xl border bg-white overflow-hidden">
          <ResizablePanel
            defaultSize={50}
            collapsible={true}
            minSize={0}
            onCollapse={() => setIsPdfCollapsed(true)}
            onExpand={() => setIsPdfCollapsed(false)}
          >
            <div className="flex h-full flex-col bg-slate-50 relative">
              <div className="p-2 border-b flex justify-between bg-white items-center">
                <span className="text-[10px] font-bold uppercase text-slate-400 px-2">Source Document</span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsPdfCollapsed(true)}>
                  <ChevronLeft size={16} />
                </Button>
              </div>
              {pdfUrl && <iframe src={pdfUrl} className="w-full h-full border-none" />}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={50}>
            <div className="flex h-full flex-col">
              <div className="p-2 border-b bg-white flex items-center">
                {isPdfCollapsed && (
                  <Button variant="ghost" size="icon" className="h-6 w-6 mr-2" onClick={() => setIsPdfCollapsed(false)}>
                    <ChevronRight size={16} />
                  </Button>
                )}
                <span className="text-[10px] font-bold uppercase text-slate-400">Review Panel</span>
              </div>

              <ScrollArea className="flex-1 p-6 bg-slate-50/20">
                <div className="max-w-2xl mx-auto space-y-6">
                  <Card className="shadow-none border-slate-200">
                    <CardHeader>
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
                            <Label className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-2">
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
                              field.id === "escalation_type" ? `Derived: ${derivedInsights.avgIncrease}%/yr` : ""
                            }
                            className={cn("text-sm", verifiedFields.has(field.id) && "border-green-200 bg-green-50/20")}
                          />
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  <Card className="shadow-none border-slate-200">
                    <CardHeader>
                      <CardTitle className="text-sm">Rent Schedule Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-3 gap-4 mb-6">
                        <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-[9px] uppercase font-bold text-slate-400 block">
                            Current Monthly Rent
                          </span>
                          <span className="text-md font-bold">${derivedInsights.currentRent.toLocaleString()}</span>
                        </div>
                        <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-[9px] uppercase font-bold text-slate-400 block">Escalation Type</span>
                          <span className="text-xs font-semibold">
                            {form.escalation_type || `${derivedInsights.avgIncrease}% /yr`}
                          </span>
                        </div>
                        <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-[9px] uppercase font-bold text-slate-400 block">Next Increase</span>
                          <span className="text-xs font-semibold">
                            {rentSchedule.find((r) => new Date(r.period_start) > new Date())?.period_start
                              ? format(
                                  new Date(
                                    rentSchedule.find((r) => new Date(r.period_start) > new Date())!.period_start,
                                  ),
                                  "MMM dd, yyyy",
                                )
                              : "Fixed"}
                          </span>
                        </div>
                      </div>
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
