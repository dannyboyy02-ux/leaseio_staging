// LimitReachedDialog — the "limit wall" (Workstream C).
//
// Shown when a workspace at its lease limit tries to start intake (Add Lease
// on /app/leases, New Request on the dashboard, or the upload modal's server
// backstop). Plan-aware: it never tells a Business workspace to "upgrade to
// Business". Three doors, cheapest-per-lease first:
//   1. Upgrade plan      — Starter only → subscription tab.
//   2. Buy a pack        — both tiers → DocumentPackDialog (from $7/lease).
//   3. Buy 1 lease       — one-time charge at the plan's overage rate
//                          ($12 starter / $10 business) granting one credit.
// Non-admins see the contact-your-admin message instead of pay flows.
//
// The single-lease purchase reuses the manage-document-pack edge function
// (mode buy_single) and the NewWorkspaceDialog/DocumentPackDialog on-session
// 3DS pattern; the webhook grants the credit via the idempotent ledger, and
// we poll for the credit before declaring success so "you can upload now" is
// true when the user reads it.

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CreditCard,
  Loader2,
  Package,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApp } from "@/contexts/AppContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";
import { useWorkspaceQuota } from "@/hooks/useWorkspaceQuota";
import { supabase } from "@/integrations/supabase/client";
import { getStripe } from "@/lib/stripe";
import { DOCUMENT_PACKS, PLANS, normalizePlanId, packPerLeasePrice } from "@/config/pricing";
import { DocumentPackDialog } from "@/components/workspace/DocumentPackDialog";

type SingleStep = "idle" | "consent" | "processing" | "success" | "error";

export function LimitReachedDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspace, refreshProfile, userRole } = useApp();
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const quota = useWorkspaceQuota();
  const isAdminUser = userRole === "admin" || userRole === "owner";

  const currentPlan = normalizePlanId(workspace?.plan);
  const overagePerDoc = PLANS[currentPlan].overagePerDoc;
  const cheapestPackPerLease = Math.min(...DOCUMENT_PACKS.map(packPerLeasePrice));

  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const [singleStep, setSingleStep] = useState<SingleStep>("idle");
  const [singleError, setSingleError] = useState<string | null>(null);
  const preCreditsRef = useRef(0);

  function resetAndClose(next: boolean) {
    if (!next) setSingleStep("idle");
    onOpenChange(next);
  }

  async function handleBuySingle() {
    if (!workspace?.id || !isAdminUser) return;
    preCreditsRef.current = workspace.purchasedLeaseCredits ?? 0;
    setSingleStep("processing");
    setSingleError(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const { data, error } = await supabase.functions.invoke("manage-document-pack", {
        body: { mode: "buy_single", workspaceId: workspace.id, idempotencyKey },
      });
      if (error) throw error;
      const resp = data as {
        ok: boolean;
        reason?: string;
        paymentIntentStatus?: string | null;
        clientSecret?: string | null;
      };
      if (!resp?.ok) {
        setSingleError(
          resp?.reason === "no_card_on_file" || resp?.reason === "no_customer"
            ? t("packs.error_no_card")
            : resp?.reason === "payment_failed"
            ? t("packs.error_payment")
            : t("packs.error_generic"),
        );
        setSingleStep("error");
        return;
      }

      if (resp.paymentIntentStatus !== "succeeded") {
        const clientSecret = resp.clientSecret ?? null;
        if (!clientSecret) {
          setSingleError(t("packs.error_generic"));
          setSingleStep("error");
          return;
        }
        const stripePromise = getStripe();
        const stripe = stripePromise ? await stripePromise : null;
        if (!stripe) {
          setSingleError(t("packs.error_unavailable"));
          setSingleStep("error");
          return;
        }
        const result = await stripe.confirmCardPayment(clientSecret);
        if (result.error) {
          setSingleError(result.error.message ?? t("packs.error_payment"));
          setSingleStep("error");
          return;
        }
      }

      // Poll until the webhook grants the credit, so the success copy
      // ("you can add your lease now") is true when shown.
      let confirmed = false;
      for (let i = 0; i < 12; i++) {
        const { data: row } = await supabase
          .from("workspaces")
          .select("purchased_lease_credits")
          .eq("id", workspace.id)
          .maybeSingle();
        const credits = Number(
          (row as { purchased_lease_credits?: number } | null)?.purchased_lease_credits ?? 0,
        );
        if (credits > preCreditsRef.current) {
          confirmed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      await refreshProfile().catch(() => {});
      setSingleStep("success");
      setSingleError(confirmed ? null : t("limit_wall.single_pending"));
    } catch {
      setSingleError(t("packs.error_generic"));
      setSingleStep("error");
    }
  }

  const metricLine =
    quota.blockedMetric === "active_leases"
      ? t("limit_wall.body_active", { used: quota.activeUsed, limit: quota.activeLimit })
      : t("limit_wall.body_monthly", { used: quota.monthlyUsed, limit: quota.monthlyLimit });

  return (
    <>
      <Dialog open={open} onOpenChange={resetAndClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t("limit_wall.title")}
            </DialogTitle>
            <DialogDescription>{metricLine}</DialogDescription>
          </DialogHeader>

          {singleStep === "processing" ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              {t("packs.processing")}
            </div>
          ) : singleStep === "success" ? (
            <div className="space-y-4 py-2 text-center">
              <CheckCircle2 className="h-10 w-10 text-success mx-auto" />
              <div>
                <p className="font-medium">{t("limit_wall.single_success_title")}</p>
                <p className="text-sm text-muted-foreground">
                  {singleError ?? t("limit_wall.single_success_desc")}
                </p>
              </div>
              <Button className="w-full" onClick={() => resetAndClose(false)}>
                {t("common.done")}
              </Button>
            </div>
          ) : singleStep === "error" ? (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>{singleError ?? t("packs.error_generic")}</p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setSingleStep("idle")}>
                  {t("common.back")}
                </Button>
                <Button onClick={() => handleBuySingle()}>
                  {t("packs.try_payment_again")}
                </Button>
              </div>
            </div>
          ) : singleStep === "consent" ? (
            <div className="space-y-4">
              <div className="rounded-md border border-border p-4 space-y-2 text-sm">
                <p className="font-medium">
                  {t("limit_wall.single_consent_title", { price: overagePerDoc })}
                </p>
                <ul className="space-y-1 text-muted-foreground">
                  <li>{t("limit_wall.single_consent_charge", { price: overagePerDoc })}</li>
                  <li>{t("limit_wall.single_consent_grant")}</li>
                  <li>{t("limit_wall.single_consent_compare", { packPrice: cheapestPackPerLease })}</li>
                </ul>
              </div>
              <div className="flex justify-between gap-2">
                <Button variant="outline" onClick={() => setSingleStep("idle")}>
                  {t("common.back")}
                </Button>
                <Button onClick={() => handleBuySingle()}>
                  <CreditCard className="h-4 w-4 mr-2" />
                  {t("limit_wall.single_confirm", { price: overagePerDoc })}
                </Button>
              </div>
            </div>
          ) : !isAdminUser ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("limit_wall.member_note")}</p>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => resetAndClose(false)}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Door 1 — upgrade (Starter only; Business has no higher tier) */}
              {currentPlan === "starter" && (
                <button
                  type="button"
                  onClick={() => {
                    resetAndClose(false);
                    navigate("/app/settings/account?tab=subscription");
                  }}
                  className="group flex w-full items-start gap-3 rounded-md border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
                >
                  <ArrowUpRight className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">{t("limit_wall.upgrade_title")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("limit_wall.upgrade_desc", {
                        price: PLANS.business.price.monthly,
                        included: PLANS.business.abstractionsIncluded,
                      })}
                    </p>
                  </div>
                </button>
              )}

              {/* Door 2 — buy a pack (cheapest per lease) */}
              <button
                type="button"
                onClick={() => setPackDialogOpen(true)}
                className="group flex w-full items-start gap-3 rounded-md border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
              >
                <Package className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-sm">{t("limit_wall.pack_title")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("limit_wall.pack_desc", { price: cheapestPackPerLease })}
                  </p>
                </div>
              </button>

              {/* Door 3 — buy a single lease at the overage rate */}
              <button
                type="button"
                onClick={() => setSingleStep("consent")}
                className="group flex w-full items-start gap-3 rounded-md border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
              >
                <CreditCard className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-sm">
                    {t("limit_wall.single_title", { price: overagePerDoc })}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("limit_wall.single_desc")}
                  </p>
                </div>
              </button>

              <div className="flex justify-end pt-1">
                <Button variant="ghost" size="sm" onClick={() => resetAndClose(false)}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Pack purchase flow, mounted alongside so the wall can hand off to it. */}
      <DocumentPackDialog open={packDialogOpen} onOpenChange={setPackDialogOpen} />
    </>
  );
}
