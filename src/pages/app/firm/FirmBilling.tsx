import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { CreditCard, FileText } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useFirm } from "@/contexts/FirmContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";

type FirmBillingRow = { billing_summary_mode: string; stripe_subscription_id: string | null; child_workspaces_used: number | null };
type ChildUsage = { workspace_id: string; workspace_name: string; firm_child_label: string | null; active_leases: number; total_documents: number; direct_members: number };

export default function FirmBilling() {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { currentFirm, currentFirmRole, isFirmUser, isLoading } = useFirm();
  const firmId = currentFirm?.firm_id;
  const isOwner = currentFirmRole === "owner";

  const { data: firm } = useQuery({
    queryKey: ["firm-billing", firmId],
    enabled: Boolean(firmId),
    queryFn: async () => {
      const { data } = await (supabase as any).from("firms").select("billing_summary_mode, stripe_subscription_id, child_workspaces_used").eq("id", firmId).maybeSingle();
      return data as FirmBillingRow | null;
    },
  });

  const { data: usage = [] } = useQuery({
    queryKey: ["firm-billing-usage", firmId],
    enabled: Boolean(firmId),
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("v_firm_child_usage").select("workspace_id, workspace_name, firm_child_label, active_leases, total_documents, direct_members").eq("firm_id", firmId);
      return (data ?? []) as ChildUsage[];
    },
  });

  const hasSubscription = Boolean(firm?.stripe_subscription_id);
  const detailed = firm?.billing_summary_mode === "detailed";

  const startCheckout = async () => {
    if (!firmId) return;
    const { data, error } = await supabase.functions.invoke("create-firm-checkout", { body: { firmId } });
    if (error || (data as any)?.ok === false || !(data as any)?.url) {
      toast.error(t("firm.billing.start_failed", { defaultValue: "Could not start billing" }));
      return;
    }
    window.location.href = (data as any).url;
  };

  const toggleMode = async (next: boolean) => {
    if (!firmId) return;
    const { error } = await (supabase as any).from("firms").update({ billing_summary_mode: next ? "detailed" : "summarized" }).eq("id", firmId);
    if (error) { toast.error(t("firm.billing.mode_failed", { defaultValue: "Could not update" })); return; }
    toast.success(t("firm.billing.mode_saved", { defaultValue: "Saved" }));
    qc.invalidateQueries({ queryKey: ["firm-billing", firmId] });
  };

  if (!isLoading && !isFirmUser) {
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto py-16 text-center">
          <CreditCard className="h-10 w-10 mx-auto text-muted-foreground/50 mb-4" />
          <h1 className="text-xl font-semibold">{t("firm.none_title")}</h1>
          <Button className="mt-6" onClick={() => navigate("/app/dashboard")}>{t("firm.back_to_workspace")}</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-2"><CreditCard className="h-5 w-5 text-primary" /><h1 className="text-2xl font-semibold">{t("firm.billing.title")}</h1></div>

        {/* Subscription status */}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t("firm.billing.subscription")}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {hasSubscription ? t("firm.billing.active") : t("firm.billing.not_set_up")}
              </p>
            </div>
            <Badge variant={hasSubscription ? "default" : "secondary"}>
              {hasSubscription ? t("firm.billing.status_active") : t("firm.billing.status_pending")}
            </Badge>
          </div>
          {!hasSubscription ? (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground">{t("firm.billing.setup_note")}</p>
              {isOwner ? (
                <Button size="sm" onClick={startCheckout}>{t("firm.billing.start")}</Button>
              ) : null}
            </div>
          ) : null}
        </Card>

        {/* Billing summary mode — only meaningful once a firm subscription exists
            (it controls how the invoice is itemized). Hidden until then (#105). */}
        {hasSubscription ? (
          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>{t("firm.billing.mode_label")}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">{detailed ? t("firm.billing.mode_detailed_desc") : t("firm.billing.mode_summarized_desc")}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{detailed ? t("firm.billing.detailed") : t("firm.billing.summarized")}</span>
                <Switch checked={detailed} disabled={!isOwner} onCheckedChange={toggleMode} />
              </div>
            </div>
            {!isOwner ? <p className="text-[11px] text-muted-foreground">{t("firm.billing.owner_only")}</p> : null}
          </Card>
        ) : null}

        {/* Per-child usage */}
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" />{t("firm.billing.usage_heading")}</h2>
          {usage.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">{t("firm.billing.no_usage")}</Card>
          ) : (
            <Card className="divide-y">
              {usage.map((c) => (
                <div key={c.workspace_id} className="flex items-center justify-between p-3 text-sm">
                  <span className="font-medium truncate">{c.firm_child_label || c.workspace_name}</span>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>{t("firm.dashboard.leases_n", { count: c.active_leases ?? 0 })}</span>
                    <span>{t("firm.dashboard.members_n", { count: c.direct_members ?? 0 })}</span>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
