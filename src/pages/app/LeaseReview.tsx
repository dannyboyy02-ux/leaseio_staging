import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
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
  AlertTriangle,
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
import { NudgeApproverButton } from "@/components/workflow/NudgeApproverButton";
import { WorkflowStatusBadge } from "@/components/workflow/WorkflowStatusBadge";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RentScheduleTable, type RentScheduleEntry } from "@/components/leases/RentScheduleTable";
import { useApp } from "@/contexts/AppContext";
import { LOW_CONFIDENCE_THRESHOLD, type AuditEntry, type ConfidenceScores } from "@/types/workflow";

interface ExtractedField {
  value: any;
  page?: number;
  confidence: "low" | "medium" | "high" | number;
}

interface ExtractedJson {
  property_address?: ExtractedField;
  landlord_name?: ExtractedField;
  tenant_name?: ExtractedField;
  lease_start?: ExtractedField;
  lease_end?: ExtractedField;
  base_rent_amount?: ExtractedField;
  monthly_rent?: ExtractedField;
  security_deposit?: ExtractedField;
  escalation_type?: ExtractedField;
}

const FIELD_CONFIG = [
  { id: "landlord_name", label: "Landlord", icon: Building2 },
  { id: "tenant_name", label: "Tenant", icon: Building2 },
  { id: "property_address", label: "Premises Address", icon: Building2 },
  { id: "lease_start", label: "Lease Start", icon: Calendar },
  { id: "lease_end", label: "Lease End", icon: Calendar },
  { id: "base_rent_amount", label: "Monthly Rent", icon: DollarSign },
  { id: "escalation_type", label: "Escalation Type", icon: Calculator },
];

export default function LeaseReview() {
  const { leaseId } = useParams<{ leaseId: string }>();
  const navigate = useNavigate();
  const { user } = useApp();
  
  const [lease, setLease] = useState<any | null>(null);
  const [rentSchedule, setRentSchedule] = useState<RentScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [basePdfUrl, setBasePdfUrl] = useState<string | null>(null);
  const [isPdfCollapsed, setIsPdfCollapsed] = useState(false);
  const [verifiedFields, setVerifiedFields] = useState<Set<string>>(new Set());
  
  // Audit tracking
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const originalValues = useRef<Record<string, string>>({});
  
  // Low-confidence field interaction tracking
  const [interactedLowConfFields, setInteractedLowConfFields] = useState<Set<string>>(new Set());

  const [form, setForm] = useState({
    landlord_name: "",
    tenant_name: "",
    property_address: "",
    lease_start: "",
    lease_end: "",
    base_rent_amount: "",
    escalation_type: "",
  });

  // Get confidence scores from lease
  const confidenceScores: ConfidenceScores = useMemo(() => {
    return (lease?.confidence_scores as ConfidenceScores) || {};
  }, [lease?.confidence_scores]);

  // Get low-confidence fields
  const lowConfidenceFields = useMemo(() => {
    return Object.entries(confidenceScores)
      .filter(([_, score]) => score < LOW_CONFIDENCE_THRESHOLD)
      .map(([field]) => field);
  }, [confidenceScores]);

  // Check if all low-confidence fields have been interacted with
  const allLowConfFieldsInteracted = useMemo(() => {
    if (lowConfidenceFields.length === 0) return true;
    return lowConfidenceFields.every(field => interactedLowConfFields.has(field));
  }, [lowConfidenceFields, interactedLowConfFields]);

  // Analyst Logic: Average Annual Increase Calculation
  const derivedInsights = useMemo(() => {
    const rawRent = form.base_rent_amount || "0";
    const startRent = parseFloat(rawRent.toString().replace(/[^0-9.]/g, "")) || 0;

    if (!rentSchedule.length || startRent === 0 || !form.lease_end || !form.lease_start) {
      return { avgIncrease: "0.00", currentRent: startRent };
    }

    const endRent = rentSchedule[rentSchedule.length - 1].monthly_amount || startRent;
    const years = Math.max(1, new Date(form.lease_end).getFullYear() - new Date(form.lease_start).getFullYear());

    const totalIncreasePercent = ((endRent - startRent) / startRent) * 100;
    const avgAnnualIncrease = (totalIncreasePercent / years).toFixed(2);

    return { avgIncrease: avgAnnualIncrease, currentRent: startRent };
  }, [rentSchedule, form]);

  // Check if lease is in "Review Required" status for showing Post button
  const isReviewRequired = lease?.lifecycle_status === 'Review Required';
  const isPendingApproval = lease?.lifecycle_status === 'Pending Approval';

  useEffect(() => {
    async function init() {
      if (!leaseId) return;
      const { data, error } = await supabase.from("leases").select("*").eq("id", leaseId).single();
      if (error) return;

      setLease(data);
      const ext = (data.extracted_json as ExtractedJson) || {};

      const formData = {
        landlord_name: data.landlord_name || ext.landlord_name?.value || "",
        tenant_name: data.tenant_name || ext.tenant_name?.value || "",
        property_address: ext.property_address?.value || "",
        lease_start: data.lease_start || ext.lease_start?.value || "",
        lease_end: data.lease_end || ext.lease_end?.value || "",
        base_rent_amount: data.base_rent_amount || ext.base_rent_amount?.value || ext.monthly_rent?.value || "",
        escalation_type: ext.escalation_type?.value || "",
      };
      
      setForm(formData);
      originalValues.current = { ...formData };
      
      // Load existing audit log
      if (data.audit_log && Array.isArray(data.audit_log)) {
        setAuditLog(data.audit_log as unknown as AuditEntry[]);
      }

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

  // Track field changes for audit log
  const handleFieldChange = useCallback((fieldId: string, newValue: string) => {
    const oldValue = form[fieldId as keyof typeof form];
    
    setForm(prev => ({ ...prev, [fieldId]: newValue }));
    
    // Only add to audit log if value actually changed from original
    if (originalValues.current[fieldId] !== newValue && oldValue !== newValue) {
      const entry: AuditEntry = {
        field: fieldId,
        oldValue: oldValue,
        newValue: newValue,
        userId: user?.id || 'unknown',
        timestamp: new Date().toISOString(),
      };
      setAuditLog(prev => [...prev, entry]);
    }
  }, [form, user?.id]);

  // Track low-confidence field interactions
  const handleFieldFocus = useCallback((fieldId: string) => {
    const confidence = confidenceScores[fieldId];
    if (confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD) {
      setInteractedLowConfFields(prev => new Set([...prev, fieldId]));
    }
  }, [confidenceScores]);

  // Get field border class based on confidence
  const getFieldBorderClass = useCallback((fieldId: string) => {
    const confidence = confidenceScores[fieldId];
    if (confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD) {
      return 'border-amber-400 border-2';
    }
    if (verifiedFields.has(fieldId)) {
      return 'border-green-200 bg-green-50/20';
    }
    return '';
  }, [confidenceScores, verifiedFields]);

  const handleSync = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("leases")
        .update({ 
          ...form,
          audit_log: JSON.parse(JSON.stringify(auditLog)),
        })
        .eq("id", lease.id);
      if (error) throw error;
      toast.success("Lease records updated successfully");
    } catch (err) {
      toast.error("Update failed");
    } finally {
      setSaving(false);
    }
  };

  const handlePostLease = async () => {
    if (!allLowConfFieldsInteracted) {
      toast.error("Please review all highlighted fields before posting");
      return;
    }

    setPosting(true);
    try {
      const { error } = await supabase
        .from("leases")
        .update({ 
          ...form,
          status: 'Posted',
          lifecycle_status: 'Posted',
          audit_log: JSON.parse(JSON.stringify(auditLog)),
        })
        .eq("id", lease.id);
      
      if (error) throw error;
      
      toast.success(
        "Lease posted successfully. The Approver and Initializer have been notified via email.",
        { duration: 5000 }
      );
      
      navigate('/app/leases');
    } catch (err) {
      console.error('Error posting lease:', err);
      toast.error("Failed to post lease");
    } finally {
      setPosting(false);
    }
  };

  if (loading)
    return (
      <div className="flex h-screen items-center justify-center font-sans text-muted-foreground">Initializing Cockpit...</div>
    );

  return (
    <AppLayout>
      <div className="flex flex-col h-screen max-h-screen overflow-hidden bg-muted/30">
        <AppHeader
          title="Abstraction Cockpit"
          subtitle={
            <div className="flex items-center gap-2">
              <span>{lease.filename}</span>
              {lease.lifecycle_status && (
                <WorkflowStatusBadge status={lease.lifecycle_status} />
              )}
            </div>
          }
          actions={
            <div className="flex items-center gap-2">
              {isPendingApproval && (
                <NudgeApproverButton 
                  leaseId={lease.id}
                  lastNudgedAt={lease.last_nudged_at}
                />
              )}
              <Button onClick={handleSync} disabled={saving} variant="outline">
                {saving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
                Save Draft
              </Button>
            </div>
          }
        />

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

            {/* Right Panel: Abstraction & Verification */}
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
                    Review & Verification Panel
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
                    {/* Card 1: Key Provisions */}
                    <Card className="shadow-none border overflow-hidden">
                      <CardHeader className="bg-muted/30 border-b pb-4">
                        <CardTitle className="text-sm font-bold flex items-center gap-2">
                          <FileText size={16} className="text-primary" /> Key Provisions
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-6 space-y-5">
                        {FIELD_CONFIG.map((field) => {
                          const confidence = confidenceScores[field.id];
                          const isLowConfidence = confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD;
                          
                          return (
                            <div key={field.id} className="group">
                              <div className="flex items-center justify-between mb-1.5">
                                <Label className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                                  <field.icon size={12} className="text-muted-foreground" /> {field.label}
                                  {confidence !== undefined ? (
                                    <Badge 
                                      variant="outline" 
                                      className={cn(
                                        "text-[9px] h-4 font-medium",
                                        isLowConfidence 
                                          ? "text-amber-600 border-amber-400 bg-amber-50" 
                                          : "bg-muted"
                                      )}
                                    >
                                      {confidence}% confidence
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="text-[9px] h-4 bg-muted font-medium">
                                      {(lease?.extracted_json as ExtractedJson)?.[field.id as keyof ExtractedJson]
                                        ?.confidence || "Manual"}
                                    </Badge>
                                  )}
                                </Label>
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground hover:text-primary"
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
                                        : "text-muted-foreground hover:text-green-600",
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
                                onChange={(e) => handleFieldChange(field.id, e.target.value)}
                                onFocus={() => handleFieldFocus(field.id)}
                                placeholder={
                                  field.id === "escalation_type" ? `Calculated: ${derivedInsights.avgIncrease}%/yr` : ""
                                }
                                className={cn(
                                  "text-sm transition-all focus-visible:ring-primary",
                                  getFieldBorderClass(field.id),
                                )}
                              />
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>

                    {/* Card 2: Rent Schedule */}
                    <Card className="shadow-none border overflow-hidden">
                      <CardHeader className="bg-muted/30 border-b pb-4">
                        <CardTitle className="text-sm font-bold flex items-center gap-2">
                          <DollarSign size={16} className="text-green-600" /> $ Rent Schedule
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-6">
                        <div className="grid grid-cols-3 gap-3 mb-8">
                          <div className="p-3 rounded-lg bg-background border shadow-sm">
                            <span className="text-[9px] uppercase font-bold text-muted-foreground block mb-1">
                              Current Monthly Rent
                            </span>
                            <span className="text-md font-bold">
                              ${derivedInsights.currentRent.toLocaleString()}
                            </span>
                          </div>
                          <div className="p-3 rounded-lg bg-background border shadow-sm">
                            <span className="text-[9px] uppercase font-bold text-muted-foreground block mb-1 flex items-center gap-1">
                              <TrendingUp size={10} /> Escalation Type
                            </span>
                            <span className="text-xs font-semibold">
                              {form.escalation_type || `${derivedInsights.avgIncrease}% /yr`}
                            </span>
                          </div>
                          <div className="p-3 rounded-lg bg-background border shadow-sm">
                            <span className="text-[9px] uppercase font-bold text-muted-foreground block mb-1 flex items-center gap-1">
                              <Calendar size={10} /> Next Increase
                            </span>
                            <span className="text-xs font-semibold">
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

                        <div className="rounded-lg border overflow-hidden">
                          <RentScheduleTable 
                            rentSchedule={rentSchedule}
                            currentMonthlyRent={derivedInsights.currentRent}
                            rentEscalationType={form.escalation_type || null}
                          />
                        </div>
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
