// DocumentPackDialog — buy / cancel recurring document capacity packs.
//
// Spec: PRODUCT_STRATEGY.md Decision 4. A pack raises the workspace's monthly
// abstraction allowance AND active-lease cap by its size while active. Each pack
// is its own Stripe subscription (full price on purchase, no proration,
// cancel-at-period-end), billed to the workspace's card on file.
//
// Flow mirrors NewWorkspaceDialog's on-session 3DS pattern, minus the
// orphan-workspace teardown: a pack whose PaymentIntent never confirms simply
// stays incomplete (Stripe abandons it; the webhook never grants capacity), so
// there is nothing to clean up.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle2, CreditCard, AlertTriangle } from "lucide-react";
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
import { supabase } from "@/integrations/supabase/client";
import { getStripe } from "@/lib/stripe";
import { DOCUMENT_PACKS, PLANS, normalizePlanId, packPerLeasePrice } from "@/config/pricing";
import { cn } from "@/lib/utils";

interface ActivePack {
  subscriptionId: string;
  packId: string;
  size: number;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
}

interface PreviewResponse {
  ok: boolean;
  eligible: boolean;
  reason: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  currentCapacity: number;
  activePacks: ActivePack[];
  catalog: Array<{ id: string; size: number; priceMonthlyUsd: number; configured: boolean }>;
}

type Step = "loading" | "catalog" | "consent" | "processing" | "success" | "error";

export function DocumentPackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspace, refreshProfile } = useApp();
  const { t, lang } = useAppTranslation();

  const [step, setStep] = useState<Step>("loading");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busySubId, setBusySubId] = useState<string | null>(null);
  const clientSecretRef = useRef<string | null>(null);

  const currentPlan = normalizePlanId(workspace?.plan);
  const overagePerDoc = PLANS[currentPlan].overagePerDoc;

  const loadPreview = useCallback(async () => {
    if (!workspace?.id) return;
    setStep("loading");
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke("manage-document-pack", {
        body: { mode: "preview", workspaceId: workspace.id },
      });
      if (error) throw error;
      const resp = data as PreviewResponse;
      if (!resp?.ok) throw new Error("preview_failed");
      setPreview(resp);
      setStep("catalog");
    } catch {
      setErrorMsg(t("packs.error_generic"));
      setStep("error");
    }
  }, [workspace?.id, t]);

  // Reset + load whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setSelectedPackId(null);
      clientSecretRef.current = null;
      void loadPreview();
    }
  }, [open, loadPreview]);

  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(lang === "es" ? "es-419" : "en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : "";

  async function handleBuy(packId: string) {
    if (!workspace?.id) return;
    setSelectedPackId(packId);
    setStep("processing");
    setErrorMsg(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const { data, error } = await supabase.functions.invoke("manage-document-pack", {
        body: { mode: "confirm", workspaceId: workspace.id, packId, idempotencyKey },
      });
      if (error) throw error;
      const resp = data as {
        ok: boolean;
        reason?: string;
        clientSecret?: string | null;
        paymentIntentStatus?: string | null;
      };
      if (!resp?.ok) {
        // pack_not_configured / no_card_on_file / stripe_error etc.
        setErrorMsg(
          resp?.reason === "pack_not_configured"
            ? t("packs.error_not_configured")
            : resp?.reason === "no_card_on_file" || resp?.reason === "no_customer"
            ? t("packs.error_no_card")
            : t("packs.error_generic"),
        );
        setStep("error");
        return;
      }

      // No-3DS card: PI already succeeded server-side.
      if (resp.paymentIntentStatus === "succeeded") {
        await finishSuccess();
        return;
      }
      const clientSecret = resp.clientSecret ?? null;
      if (!clientSecret) {
        setErrorMsg(t("packs.error_generic"));
        setStep("error");
        return;
      }
      clientSecretRef.current = clientSecret;

      const stripePromise = getStripe();
      const stripe = stripePromise ? await stripePromise : null;
      if (!stripe) {
        setErrorMsg(t("packs.error_unavailable"));
        setStep("error");
        return;
      }
      const result = await stripe.confirmCardPayment(clientSecret);
      clientSecretRef.current = null;
      if (result.error) {
        setErrorMsg(result.error.message ?? t("packs.error_payment"));
        setStep("error");
        return;
      }
      await finishSuccess();
    } catch {
      setErrorMsg(t("packs.error_generic"));
      setStep("error");
    }
  }

  async function finishSuccess() {
    // Webhook mirrors capacity asynchronously; refresh so the meter/cards pick
    // it up. We don't block on a poll — the success copy says it may take a moment.
    setStep("success");
    await refreshProfile().catch(() => {});
  }

  async function handleCancel(sub: ActivePack) {
    if (!workspace?.id) return;
    setBusySubId(sub.subscriptionId);
    try {
      const { data, error } = await supabase.functions.invoke("manage-document-pack", {
        body: { mode: "cancel", workspaceId: workspace.id, subscriptionId: sub.subscriptionId },
      });
      if (error) throw error;
      if (!(data as { ok?: boolean })?.ok) throw new Error("cancel_failed");
      await loadPreview();
    } catch {
      setErrorMsg(t("packs.error_generic"));
      setStep("error");
    } finally {
      setBusySubId(null);
    }
  }

  const selectedPack = selectedPackId
    ? DOCUMENT_PACKS.find((p) => p.id === selectedPackId) ?? null
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("packs.dialog_title")}</DialogTitle>
          <DialogDescription>{t("packs.dialog_desc")}</DialogDescription>
        </DialogHeader>

        {step === "loading" && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            {t("packs.loading")}
          </div>
        )}

        {step === "error" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <p>{errorMsg ?? t("packs.error_generic")}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
              <Button onClick={() => loadPreview()}>{t("account.retry")}</Button>
            </div>
          </div>
        )}

        {step === "catalog" && preview && (
          <div className="space-y-4">
            {!preview.eligible ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                {t("packs.no_card_banner")}
              </div>
            ) : (
              <>
                {/* Active packs (if any) with cancel affordance */}
                {preview.activePacks.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("packs.active_heading", { count: preview.currentCapacity })}
                    </p>
                    {preview.activePacks.map((p) => (
                      <div
                        key={p.subscriptionId}
                        className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <div>
                          <span className="font-medium">
                            {t("packs.pack_label", { size: p.size })}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {p.cancelAtPeriodEnd
                              ? t("packs.ends_on", { date: fmtDate(p.currentPeriodEnd) })
                              : t("packs.renews_on", { date: fmtDate(p.currentPeriodEnd) })}
                          </span>
                        </div>
                        {!p.cancelAtPeriodEnd && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCancel(p)}
                            disabled={busySubId === p.subscriptionId}
                          >
                            {busySubId === p.subscriptionId ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              t("packs.cancel")
                            )}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Catalog */}
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t("packs.overage_compare", { rate: overagePerDoc })}
                  </p>
                  {DOCUMENT_PACKS.map((pack) => {
                    const cfg = preview.catalog.find((c) => c.id === pack.id);
                    const perLease = packPerLeasePrice(pack);
                    const configured = cfg?.configured ?? false;
                    return (
                      <button
                        key={pack.id}
                        type="button"
                        disabled={!configured}
                        onClick={() => {
                          setSelectedPackId(pack.id);
                          setStep("consent");
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md border px-4 py-3 text-left transition-colors",
                          configured
                            ? "border-border hover:border-primary hover:bg-muted/40"
                            : "border-border/60 opacity-50 cursor-not-allowed",
                        )}
                      >
                        <div>
                          <p className="font-medium">{t("packs.pack_label", { size: pack.size })}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("packs.per_lease", { price: perLease })}
                            {configured ? "" : ` · ${t("packs.unavailable")}`}
                          </p>
                        </div>
                        <span className="text-lg font-bold">${pack.priceMonthly}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        )}

        {step === "consent" && selectedPack && preview && (
          <div className="space-y-4">
            <div className="rounded-md border border-border p-4 space-y-2 text-sm">
              <p className="font-medium">{t("packs.pack_label", { size: selectedPack.size })}</p>
              <ul className="space-y-1 text-muted-foreground">
                <li>{t("packs.consent_charge", { price: selectedPack.priceMonthly })}</li>
                <li>{t("packs.consent_recurring", { price: selectedPack.priceMonthly })}</li>
                <li>
                  {preview.cardLast4
                    ? t("packs.consent_card", {
                        brand: preview.cardBrand ?? "card",
                        last4: preview.cardLast4,
                      })
                    : t("packs.consent_card_generic")}
                </li>
                <li>{t("packs.consent_cancel")}</li>
              </ul>
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={() => setStep("catalog")}>
                {t("common.back")}
              </Button>
              <Button onClick={() => handleBuy(selectedPack.id)}>
                <CreditCard className="h-4 w-4 mr-2" />
                {t("packs.confirm_buy", { price: selectedPack.priceMonthly })}
              </Button>
            </div>
          </div>
        )}

        {step === "processing" && (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            {t("packs.processing")}
          </div>
        )}

        {step === "success" && (
          <div className="space-y-4 py-2 text-center">
            <CheckCircle2 className="h-10 w-10 text-success mx-auto" />
            <div>
              <p className="font-medium">{t("packs.success_title")}</p>
              <p className="text-sm text-muted-foreground">{t("packs.success_desc")}</p>
            </div>
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              {t("common.done")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
