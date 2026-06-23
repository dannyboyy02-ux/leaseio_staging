import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { CreditCard, FileText, Loader2, RefreshCw } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { PageLayout } from "@/components/layout/PageLayout";
import { FirmNotMemberState } from "@/components/firm/FirmNotMemberState";
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
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentFirm, currentFirmRole, isFirmUser, isLoading } = useFirm();
  const firmId = currentFirm?.firm_id;
  const isOwner = currentFirmRole === "owner";

  // True briefly after a successful checkout return, while we wait for the
  // Stripe webhook to write stripe_subscription_id. Drives a "Finalizing…"
  // pending state so we never show "Not set up" + a re-pay button under a
  // "you're subscribed" toast (audit C3 — don't re-create the dead-end).
  const [finalizing, setFinalizing] = useState(false);
  // Set if the webhook still hasn't landed after the finalize window — shows a
  // distinct "still syncing" card (refresh / contact support) rather than the
  // bare "Not set up" + pay button, which would re-create the C3 anxiety.
  const [timedOut, setTimedOut] = useState(false);

  // Acknowledge the Stripe Checkout return (audit C3). create-firm-checkout
  // lands here on both success and cancel; without this the user got no
  // confirmation and could assume the card was declined and try to pay again.
  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (checkout !== "success" && checkout !== "canceled") return;
    if (checkout === "success") {
      // Wait for FirmContext to resolve before consuming the param — otherwise
      // the poll (enabled on firmId) can't run and the spinner stalls until the
      // 30s timeout on a cold/deep-link return.
      if (!firmId) return;
      if (isOwner) {
        toast.success(t("firm.billing.checkout_success"));
        setFinalizing(true);
        // The subscription row is written by the Stripe webhook and can lag a
        // moment — refetch so the status flips to Active once it lands.
        qc.invalidateQueries({ queryKey: ["firm-billing", firmId] });
      }
    } else {
      toast.info(t("firm.billing.checkout_canceled"));
    }
    const next = new URLSearchParams(searchParams);
    next.delete("checkout");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, qc, firmId, isOwner, t]);

  const { data: firm } = useQuery({
    queryKey: ["firm-billing", firmId],
    enabled: Boolean(firmId),
    // Poll while finalizing so the badge flips to Active on its own once the
    // webhook lands (bounded by the effects below — never an infinite poll).
    refetchInterval: finalizing ? 2500 : false,
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

  // The webhook write landed (badge → Active): clear both pending states, incl.
  // a late arrival after the timeout already showed the "still syncing" card.
  useEffect(() => {
    if (hasSubscription) {
      setFinalizing(false);
      setTimedOut(false);
    }
  }, [hasSubscription]);

  // Safety net: if the webhook hasn't landed in 30s, drop the spinner but show a
  // distinct "still syncing" card (refresh / contact support) — never the bare
  // "Not set up" + pay button, which would re-create the C3 anxiety.
  useEffect(() => {
    if (!finalizing) return;
    const timer = setTimeout(() => {
      setFinalizing(false);
      setTimedOut(true);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [finalizing]);

  // "Refresh" from the still-syncing card: re-enter the finalize/poll window.
  const retryFinalize = () => {
    setTimedOut(false);
    setFinalizing(true);
    if (firmId) qc.invalidateQueries({ queryKey: ["firm-billing", firmId] });
  };

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
    return <FirmNotMemberState icon={CreditCard} />;
  }

  return (
    <AppLayout>
      <AppHeader icon={CreditCard} title={t("firm.billing.title")} />
      <PageLayout width="default">
        {/* Subscription status */}
        {finalizing && !hasSubscription ? (
          // Post-checkout, pre-webhook: speak with one voice. No "Not set up"
          // badge, no re-pay button — just an honest "finishing up" (audit C3).
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
              <div>
                <p className="text-sm font-medium">{t("firm.billing.finalizing")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t("firm.billing.finalizing_note")}</p>
              </div>
            </div>
          </Card>
        ) : timedOut && !hasSubscription ? (
          // Webhook didn't land in the window: acknowledge the payment + offer a
          // refresh, NOT a "Not set up" + pay button (which would read as "did my
          // payment fail?" — the exact C3 anxiety, relocated).
          <Card className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{t("firm.billing.finalizing_delayed")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t("firm.billing.finalizing_delayed_note")}</p>
              </div>
              <Button size="sm" variant="outline" onClick={retryFinalize} className="shrink-0">
                <RefreshCw className="h-3.5 w-3.5 mr-1" />{t("firm.billing.refresh")}
              </Button>
            </div>
          </Card>
        ) : (
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
        )}

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
      </PageLayout>
    </AppLayout>
  );
}
