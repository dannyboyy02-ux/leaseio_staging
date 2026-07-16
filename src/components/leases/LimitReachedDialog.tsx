// LimitReachedDialog — the "limit wall" (Workstream C).
//
// Shown when a workspace at its lease limit tries to start intake (Add Lease
// on /app/leases, New Request on the dashboard, Upload on /app/imports, or the
// upload modal's server backstop). Plan-aware: it never tells a Business
// workspace to "upgrade to Business". Doors, cheapest-per-lease first:
//   1. Upgrade plan      — Starter only → subscription tab.
//   2. Buy a pack        — both tiers → DocumentPackDialog (from $7/lease).
//   3. Buy 1 lease       — one-time charge at the plan's overage rate
//                          ($12 starter / $10 business) granting one credit.
//   + Archive a lease    — free, only when the ACTIVE-lease cap tripped.
// Non-admins see the contact-your-admin message instead of pay flows.
//
// Double-charge defenses (review HIGHs): the single-lease idempotency key is
// generated ONCE per consent session (a "Try payment again" retry reuses it),
// and a workspace-scoped "payment pending" marker (set when a charge succeeds
// but the grant webhook outruns our poll) replaces the pay door with a
// "payment received — credit on the way" panel on reopen, so a user who just
// paid is never offered the same charge again.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  CheckCircle2,
  Clock,
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
import { confirmSavedMethodPayment } from "@/lib/stripeConfirm";
import { DOCUMENT_PACKS, PLANS, normalizePlanId, packPerLeasePrice } from "@/config/pricing";
import { DocumentPackDialog } from "@/components/workspace/DocumentPackDialog";

type SingleStep = "idle" | "consent" | "processing" | "success" | "error";

const pendingMarkerKey = (workspaceId: string) => `lease_credit_pending:${workspaceId}`;

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
  // Firm-bound workspaces have billing + capacity managed by the firm; the
  // paid doors (upgrade/pack/single) all 403 with firm_managed server-side, so
  // we hide them and point the admin at the firm instead (audit D1). The free
  // archive door still works (it's a workspace op, not a purchase).
  const firmBound = Boolean(workspace?.firmId);
  const overagePerDoc = PLANS[currentPlan].overagePerDoc;
  const cheapestPackPerLease = Math.min(...DOCUMENT_PACKS.map(packPerLeasePrice));
  const cheapestPackMonthly = Math.min(...DOCUMENT_PACKS.map((p) => p.priceMonthly));

  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const [singleStep, setSingleStep] = useState<SingleStep>("idle");
  const [singleError, setSingleError] = useState<string | null>(null);
  const [paymentPending, setPaymentPending] = useState(false);
  const preCreditsRef = useRef(0);
  const idempotencyRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const wsId = workspace?.id ?? null;
  const markerKey = wsId ? pendingMarkerKey(wsId) : null;

  // On open: surface a recent-but-unconfirmed purchase as a "credit on the way"
  // panel instead of the pay doors (never re-offer a charge to someone who just
  // paid), and reset any stale inline step. While pending, poll for the grant.
  useEffect(() => {
    if (!open) return;
    const pending = markerKey ? sessionStorage.getItem(markerKey) === "1" : false;
    setPaymentPending(pending);
    setSingleError(null);
    setSingleStep(pending ? "success" : "idle");
    if (!pending) return;

    let cancelled = false;
    (async () => {
      for (let i = 0; i < 20 && !cancelled; i++) {
        await refreshProfile().catch(() => {});
        if (cancelled) return;
        if ((workspace?.purchasedLeaseCredits ?? 0) > 0) {
          if (markerKey) sessionStorage.removeItem(markerKey);
          if (!cancelled) setPaymentPending(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, markerKey]);

  function requestClose(next: boolean) {
    // Never let the dialog be dismissed mid-charge — the PaymentIntent is in
    // flight and a stale reopen would be confusing.
    if (!next && singleStep === "processing") return;
    if (!next) {
      setSingleStep("idle");
      setSingleError(null);
    }
    onOpenChange(next);
  }

  async function handleBuySingle() {
    if (!workspace?.id || !isAdminUser) return;
    preCreditsRef.current = workspace.purchasedLeaseCredits ?? 0;
    setSingleStep("processing");
    setSingleError(null);
    try {
      // Reuse the consent-session key across retries so an ambiguous failure +
      // "Try payment again" can't double-charge (one key per intended purchase).
      if (!idempotencyRef.current) idempotencyRef.current = crypto.randomUUID();
      const { data, error } = await supabase.functions.invoke("manage-document-pack", {
        body: { mode: "buy_single", workspaceId: workspace.id, idempotencyKey: idempotencyRef.current },
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
        const result = await confirmSavedMethodPayment(stripe, clientSecret);
        if (result.error) {
          setSingleError(result.error.message ?? t("packs.error_payment"));
          setSingleStep("error");
          return;
        }
      }

      // Payment succeeded — this key is now spent; a fresh purchase needs a new one.
      idempotencyRef.current = null;

      // Poll until the webhook grants the credit, so "you can add your lease
      // now" is true when shown.
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
      if (!openRef.current) return; // dialog closed mid-flight — don't flip state
      if (confirmed) {
        if (markerKey) sessionStorage.removeItem(markerKey);
        setPaymentPending(false);
      } else {
        // Paid but grant not yet visible — mark pending so a reopen shows the
        // "credit on the way" panel rather than the pay door again.
        if (markerKey) sessionStorage.setItem(markerKey, "1");
        setPaymentPending(true);
      }
      setSingleStep("success");
    } catch {
      setSingleError(t("packs.error_generic"));
      setSingleStep("error");
    }
  }

  const metricLine =
    quota.blockedMetric === "active_leases"
      ? t("limit_wall.body_active", { used: quota.activeUsed, limit: quota.activeLimit })
      : t("limit_wall.body_monthly", { used: quota.monthlyUsed, limit: quota.monthlyLimit });
  const title =
    quota.blockedMetric === "active_leases" ? t("limit_wall.title_active") : t("limit_wall.title_monthly");

  return (
    <>
      <Dialog open={open} onOpenChange={requestClose}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {title}
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
              {paymentPending ? (
                <Clock className="h-10 w-10 text-amber-500 mx-auto" />
              ) : (
                <CheckCircle2 className="h-10 w-10 text-success mx-auto" />
              )}
              <div>
                <p className="font-medium">
                  {paymentPending ? t("limit_wall.single_pending_title") : t("limit_wall.single_success_title")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {paymentPending ? t("limit_wall.single_pending") : t("limit_wall.single_success_desc")}
                </p>
              </div>
              <Button className="w-full" onClick={() => requestClose(false)}>
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
                <Button onClick={() => handleBuySingle()}>{t("packs.try_payment_again")}</Button>
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
              <p className="text-sm text-muted-foreground">
                {/* Firm-bound: the admin can't purchase either (capacity is
                    firm-managed), so point the member at the firm, not the admin. */}
                {firmBound ? t("limit_wall.firm_managed_desc", { firm: workspace?.firmName ?? t("account.firm_fallback") }) : t("limit_wall.member_note")}
              </p>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => requestClose(false)}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Free door — archive an active lease (only when the active cap
                  tripped; never hide the $0 path on a payment wall) */}
              {quota.blockedMetric === "active_leases" && (
                <button
                  type="button"
                  onClick={() => {
                    requestClose(false);
                    navigate("/app/leases");
                  }}
                  className="group flex w-full items-start gap-3 rounded-md border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
                >
                  <Archive className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">{t("limit_wall.archive_title")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t("limit_wall.archive_desc")}</p>
                  </div>
                </button>
              )}

              {/* Firm-bound: the paid doors below all 403; explain who owns
                  capacity instead. (Archive above still works.) */}
              {firmBound ? (
                <div className="rounded-md border border-primary/40 bg-primary/5 p-4">
                  <p className="font-medium text-sm">{t("limit_wall.firm_managed_title")}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("limit_wall.firm_managed_desc", { firm: workspace?.firmName ?? t("account.firm_fallback") })}
                  </p>
                </div>
              ) : (
              <>
              {/* Door 1 — upgrade (Starter only; Business has no higher tier) */}
              {currentPlan === "starter" && (
                <button
                  type="button"
                  onClick={() => {
                    requestClose(false);
                    navigate("/app/settings/account?tab=billing");
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
                    {t("limit_wall.pack_desc", { price: cheapestPackPerLease, monthly: cheapestPackMonthly })}
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
                  <p className="text-xs text-muted-foreground mt-0.5">{t("limit_wall.single_desc")}</p>
                </div>
              </button>
              </>
              )}

              <div className="flex justify-end pt-1">
                <Button variant="ghost" size="sm" onClick={() => requestClose(false)}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Pack purchase flow. When it closes after a purchase that cleared the
          block, close the wall too — never strand a paying customer on a wall
          that still says "you've reached your limit". */}
      <DocumentPackDialog
        open={packDialogOpen}
        onOpenChange={(next) => {
          setPackDialogOpen(next);
          if (!next && !quota.blocked) requestClose(false);
        }}
      />
    </>
  );
}
