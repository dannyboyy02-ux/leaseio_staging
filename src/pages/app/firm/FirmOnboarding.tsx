import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Building2, ArrowRight, Loader2, Check } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/contexts/AppContext";
import { useFirm } from "@/contexts/FirmContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";
import { PLANS } from "@/config/pricing";

type Step = "details" | "workspace" | "billing";

export default function FirmOnboarding() {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const { user } = useApp();
  const { currentFirm, refreshFirm } = useFirm();

  const [step, setStep] = useState<Step>("details");
  const [busy, setBusy] = useState(false);

  // Step 1 — firm details
  const [name, setName] = useState("");
  const [firmType, setFirmType] = useState("cpa_firm");
  const [billingEmail, setBillingEmail] = useState(user?.email ?? "");
  const [firmId, setFirmId] = useState<string | null>(null);

  // Step 2 — first workspace
  const [wsName, setWsName] = useState("");

  // Resume, don't restart: a user who already has a firm (e.g. they took the
  // "add a workspace later" escape, or re-opened the wizard) must land on the
  // workspace step — re-showing create-firm here would mint a duplicate. This
  // is also what makes the step-2 escape honest: FirmDashboard's empty state
  // links back here and the wizard picks up where they left off.
  useEffect(() => {
    if (currentFirm && !firmId && step === "details") {
      setFirmId(currentFirm.firm_id);
      setStep("workspace");
    }
  }, [currentFirm, firmId, step]);

  const createFirm = async () => {
    if (!name.trim() || !billingEmail.trim()) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("create-firm", {
      body: { name: name.trim(), firmType, billingEmail: billingEmail.trim() },
    });
    setBusy(false);
    if (error || (data as any)?.ok === false || !(data as any)?.firm?.id) {
      toast.error(t("firm.onboarding.create_failed", { defaultValue: "Could not create the firm" }));
      return;
    }
    setFirmId((data as any).firm.id);
    void refreshFirm();
    setStep("workspace");
  };

  const addWorkspace = async () => {
    if (!firmId || !wsName.trim()) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("create-firm-workspace", {
      body: { firmId, name: wsName.trim(), idempotencyKey: `${firmId}-${wsName.trim()}-${user?.id ?? ""}` },
    });
    setBusy(false);
    if (error || (data as any)?.ok === false) {
      toast.error(t("firm.onboarding.workspace_failed", { defaultValue: "Could not create the workspace" }));
      return;
    }
    void refreshFirm();
    setStep("billing");
  };

  const startCheckout = async () => {
    if (!firmId) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("create-firm-checkout", { body: { firmId } });
    if (error || (data as any)?.ok === false || !(data as any)?.url) {
      setBusy(false);
      toast.error(t("firm.onboarding.checkout_failed", { defaultValue: "Could not start billing" }));
      return;
    }
    window.location.href = (data as any).url; // redirect to Stripe Checkout (card + 3DS)
  };

  const dot = (s: Step, label: string) => {
    const order: Step[] = ["details", "workspace", "billing"];
    const done = order.indexOf(step) > order.indexOf(s);
    const active = step === s;
    return (
      <div className="flex items-center gap-2">
        <div className={`h-6 w-6 rounded-full flex items-center justify-center text-[11px] ${done ? "bg-primary text-primary-foreground" : active ? "border-2 border-primary text-primary" : "border border-muted-foreground/30 text-muted-foreground"}`}>
          {done ? <Check className="h-3.5 w-3.5" /> : order.indexOf(s) + 1}
        </div>
        <span className={`text-xs ${active ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
      </div>
    );
  };

  return (
    <AppLayout>
      {/* Intentional centered-wizard treatment (not the sticky AppHeader) — a
          pre-firm creation flow. Padding matches PageLayout so cards don't
          touch the viewport edge on mobile. */}
      <div className="max-w-lg mx-auto px-4 py-6 sm:px-6 space-y-6">
        <div className="text-center">
          <Building2 className="h-8 w-8 mx-auto text-primary mb-2" />
          <h1 className="text-2xl font-semibold">{t("firm.onboarding.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("firm.onboarding.subtitle")}</p>
        </div>

        <div className="flex items-center justify-center gap-4">
          {dot("details", t("firm.onboarding.step_details"))}
          <div className="h-px w-6 bg-muted-foreground/20" />
          {dot("workspace", t("firm.onboarding.step_workspace"))}
          <div className="h-px w-6 bg-muted-foreground/20" />
          {dot("billing", t("firm.onboarding.step_billing"))}
        </div>

        {step === "details" ? (
          <Card className="p-5">
            {/* Form wrapper: Enter in any field advances the step. */}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void createFirm();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="fname">{t("firm.settings.name")}</Label>
                <Input id="fname" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("firm.onboarding.name_placeholder")} />
              </div>
              <div className="space-y-1.5">
                <Label>{t("firm.settings.type")}</Label>
                <Select value={firmType} onValueChange={setFirmType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cpa_firm">{t("firm.settings.type_cpa")}</SelectItem>
                    <SelectItem value="parent_company">{t("firm.settings.type_parent")}</SelectItem>
                    <SelectItem value="other">{t("firm.settings.type_other")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bemail">{t("firm.settings.billing_email")}</Label>
                <Input id="bemail" type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={busy || name.trim().length < 2 || !billingEmail.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>{t("firm.onboarding.continue")}<ArrowRight className="h-4 w-4 ml-1" /></>}
              </Button>
              {/* FS-16: nothing is committed yet at this step, so the wizard
                  must offer a way out. Cancel goes HOME — /app/firm would greet
                  the canceller with the same "Set up a firm" CTA they just
                  declined. (Steps 2/3 are forward-only by design — each
                  Continue is a server commit — so they get "later" escapes
                  instead of a misleading Back.) */}
              <Button
                type="button"
                variant="link"
                size="sm"
                className="w-full text-xs text-muted-foreground"
                onClick={() => navigate("/app/dashboard")}
                disabled={busy}
              >
                {t("common.cancel")}
              </Button>
            </form>
          </Card>
        ) : step === "workspace" ? (
          <Card className="p-5">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void addWorkspace();
              }}
            >
              <p className="text-sm text-muted-foreground">{t("firm.onboarding.workspace_hint")}</p>
              <div className="space-y-1.5">
                <Label htmlFor="wsname">{t("firm.onboarding.workspace_name")}</Label>
                <Input id="wsname" value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder={t("firm.onboarding.workspace_placeholder")} />
              </div>
              <Button type="submit" className="w-full" disabled={busy || !wsName.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>{t("firm.onboarding.continue")}<ArrowRight className="h-4 w-4 ml-1" /></>}
              </Button>
              {/* The firm already exists here; this escape is honest because
                  FirmDashboard's empty state links back to this wizard, which
                  resumes at this step (see the resume effect above). */}
              <Button
                type="button"
                variant="link"
                size="sm"
                className="w-full text-xs text-muted-foreground"
                onClick={() => navigate("/app/firm")}
                disabled={busy}
              >
                {t("firm.onboarding.skip_workspace")}
              </Button>
            </form>
          </Card>
        ) : (
          <Card className="p-5 space-y-4 text-center">
            <p className="text-sm">{t("firm.onboarding.billing_summary")}</p>
            <p className="text-2xl font-semibold">{t("firm.onboarding.price_per_workspace", { price: PLANS.business.price.monthly })}</p>
            <p className="text-xs text-muted-foreground">{t("firm.onboarding.billing_note")}</p>
            <Button className="w-full" onClick={startCheckout} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("firm.onboarding.to_payment")}
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="w-full text-xs text-muted-foreground"
              onClick={() => navigate("/app/firm")}
              disabled={busy}
            >
              {t("firm.onboarding.do_later")}
            </Button>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}
