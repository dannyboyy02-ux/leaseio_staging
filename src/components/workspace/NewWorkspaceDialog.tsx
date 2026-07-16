import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAppTranslation } from "@/hooks/useAppTranslation";
import { supabase } from "@/integrations/supabase/client";
import { getStripe } from "@/lib/stripe";
import { confirmSavedMethodPayment } from "@/lib/stripeConfirm";
import { useApp } from "@/contexts/AppContext";

// New-workspace dialog + confirmation modal — the money-stakes UX for the
// Phase 2 multi-workspace flow.
//
// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.2, §P2.3, §P2.11.
//
// Owned invariants (each one came directly from the pressure-test review and
// must NOT be relaxed without re-routing through the reviewers):
//   • idempotencyKey lives in a useRef initialized at modal-open — never in
//     localStorage/sessionStorage, never regenerated per click.
//   • clientSecret is cleared from state immediately after payment confirmation
//     resolves; we never log the response body of `create-workspace`.
//   • Modal becomes non-dismissable (Esc + overlay-click) during the in-flight
//     payment window (confirm → 3DS → activating). The browser back/tab-close
//     paths are backstopped by the abandonment sweep + the "Resume setup"
//     affordance in the sidebar (a separate Phase 2 deliverable).
//   • Activation polling targets a narrow SELECT on the new workspace's
//     subscription_status (the original AppContext.fetchProfile target literally
//     could not observe activation — availableWorkspaces selects only id/name/plan).
//   • On payment confirmation error, we call stripe.retrievePaymentIntent FIRST
//     and only call mode:'cancel' when the PI is genuinely not succeeded —
//     avoids tearing down a workspace whose payment actually completed.
//   • Branch-aware timeout copy: PI succeeded but webhook lagged → "almost
//     there"; PI not succeeded → "longer than expected, you'll get an email."

type DialogStep =
  | "acknowledge"   // step 0 — price-awareness gate (before name); suppressible
  | "name"          // step 1 — name input
  | "preview"       // step 1 → 2 in-flight (calling preview)
  | "confirm"       // step 2 — consent modal
  | "confirming"    // step 2 in-flight (server confirm + Stripe sub create)
  | "three_ds"      // payment confirmation running
  | "activating"    // PI succeeded; polling for the webhook entitlement flip
  | "activated"     // success — Switch to it / Stay here
  | "timeout_paid"  // 30s timeout, but PI did succeed (webhook lag)
  | "timeout_unpaid"// 30s timeout, PI did not succeed
  | "error";

// Acknowledge-step substate. The price-awareness gate fires the existing
// `mode: "preview"` eligibility call on open; this drives which variant of the
// gate renders. Kept separate from `step` so the background fetch never yanks
// the user out of the acknowledge panel.
type AckState =
  | "loading"   // eligibility call in flight
  | "ready"     // Business + saved method + under cap → show the price gate
  | "starter"   // not on Business → route to upgrade
  | "no_card"   // no saved payment method (any type) / no Stripe customer → route to billing
  | "cap"       // at the workspace cap → informational
  | "error";    // eligibility call failed

interface ErrorState {
  reason: string;
  message?: string;
  count?: number;
  cap?: number;
}

interface PreviewData {
  /** Human label for the saved method of ANY type ("Visa •••• 4242",
   * "Stripe Link (a@b.com)") — #161. */
  methodLabel: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  priceMonthly: number;
  chargedToday: number;
  count: number;
  cap: number;
}

interface ConfirmResult {
  ok: boolean;
  workspaceId?: string;
  clientSecret?: string | null;
  paymentIntentStatus?: string | null;
  reason?: string;
  error?: string;
  status?: string;
}

interface NewWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional pre-filled name (e.g. when launched from a recovery affordance). */
  initialName?: string;
  /**
   * Resume an existing pending workspace by id. When set, the dialog opens
   * directly into the confirm step using the existing Stripe PaymentIntent
   * (re-fetched via the preview endpoint), bypassing the name + new-sub
   * creation path. This is the spec §P2.11 mitigation for the HIGH-sec
   * "3DS network-fail or tab-close → workspace orphans" finding — without
   * it, a user can see the pending workspace but can't finish paying.
   */
  resumeWorkspaceId?: string | null;
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30000;

// Per-device suppression of the price-awareness gate. Stored in localStorage,
// NOT a profile column: this is an awareness nag, not legal consent — the
// binding consent (the confirm step, with the real card + exact charge) is
// never suppressible and always renders. A new device legitimately re-shows
// the awareness gate. Only ever set by an eligible Business owner.
export const ACK_SUPPRESS_KEY = "workspace_create_acknowledge_dismissed";

function ackSuppressed(): boolean {
  try {
    return localStorage.getItem(ACK_SUPPRESS_KEY) === "1";
  } catch {
    return false; // storage blocked (private mode) → always show the gate
  }
}

// Each workspace's subscription anchors to its creation day (no proration), so
// the renewal day is "today". Format it for the awareness copy: English uses an
// ordinal ("10th"), Spanish uses the cardinal ("10", as in "el 10 de cada mes").
function renewalDayLabel(lang: string): string {
  const day = new Date().getDate();
  if (lang?.startsWith("es")) return String(day);
  const v = day % 100;
  const suffix =
    v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${day}${suffix}`;
}

function randomKey(): string {
  // Stable client UUIDish — 24+ hex chars. crypto.randomUUID is safer than
  // Math.random for an idempotency key the server treats as a unique row PK.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function NewWorkspaceDialog({
  open,
  onOpenChange,
  initialName = "",
  resumeWorkspaceId = null,
}: NewWorkspaceDialogProps) {
  const { t, lang } = useAppTranslation();
  const navigate = useNavigate();
  const { switchWorkspace } = useApp();
  const isResume = !!resumeWorkspaceId;

  // Initial step: resume jumps straight to the PI re-fetch; otherwise the
  // price-awareness gate unless the owner suppressed it (then straight to name).
  const [step, setStep] = useState<DialogStep>(
    isResume ? "preview" : ackSuppressed() ? "name" : "acknowledge",
  );
  const [name, setName] = useState<string>(initialName);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);
  const [ackState, setAckState] = useState<AckState>("loading");
  const [suppress, setSuppress] = useState<boolean>(false);

  // Idempotency key lives in a ref so a re-render doesn't reroll it, and so a
  // closed-and-reopened dialog gets a FRESH key (the reset on dialog close is
  // the entire point — see useEffect below). Never persist this to storage.
  const idempotencyKeyRef = useRef<string | null>(null);

  // Hold the latest clientSecret in a ref so we can pass it to retrievePaymentIntent
  // for recovery WITHOUT keeping it in component state any longer than needed.
  const clientSecretRef = useRef<string | null>(null);

  // Cleanup pollers on unmount / dialog close. The poll runs as an async loop
  // gated by a boolean flag in the closure — flip it and the loop exits before
  // its next setState. Spec §P2.11 mandates "AbortController + cleanup"; the
  // boolean is functionally equivalent here because there's no in-flight
  // fetch/subscription to abort (we await a setTimeout between rounds, then
  // check the flag), and Supabase's PostgREST client cannot accept an
  // AbortSignal on the relevant query method. Declared before
  // pollForActivation so the function's first read isn't a forward reference.
  const pollCleanupRef = useRef<(() => void) | null>(null);

  // Reset everything on dialog close so a fresh open starts clean.
  useEffect(() => {
    if (!open) {
      // Reset to the SAME entry step the useState initializer derives, not a
      // hardcoded "name" — otherwise a non-suppressed reopen paints the name
      // step for one frame before the open branch flips it back to the gate.
      setStep(isResume ? "preview" : ackSuppressed() ? "name" : "acknowledge");
      setName(initialName);
      setPreview(null);
      setError(null);
      setCreatedWorkspaceId(null);
      setAckState("loading");
      setSuppress(false);
      idempotencyKeyRef.current = null;
      clientSecretRef.current = null;
      return;
    }
    if (idempotencyKeyRef.current === null) {
      idempotencyKeyRef.current = randomKey();
    }
    // Resume path: as soon as the dialog opens for a pending workspace, fetch
    // the existing PaymentIntent via the preview endpoint and route into the
    // confirm step. The standard new-workspace path is name-driven and waits
    // for the user — resume has no name input, so it auto-runs.
    if (isResume) {
      setStep("preview");
      void runPreview(resumeWorkspaceId!);
      return;
    }
    // Standard path: open into the price-awareness gate (unless suppressed) and
    // fire the eligibility check in the background. Suppressed owners skip
    // straight to the name step — the binding confirm step still gates the
    // actual charge for them.
    if (ackSuppressed()) {
      setStep("name");
    } else {
      setStep("acknowledge");
      void runAcknowledgePreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runPreview/runAcknowledgePreview are stable within this render
  }, [open, initialName, isResume, resumeWorkspaceId]);

  // Non-dismissable during the payment window. onOpenChange is the dialog's
  // close path; suppress it for the in-flight steps.
  const isInFlight =
    step === "confirming" || step === "three_ds" || step === "activating";
  const handleOpenChange = (next: boolean) => {
    if (!next && isInFlight) return;
    onOpenChange(next);
  };

  // Price-awareness gate: run the SAME eligibility check the confirm path uses
  // (`mode: "preview"`, no name required), but route the result into `ackState`
  // instead of advancing `step`. Drives which variant of the gate renders. The
  // dollar amounts on the "ready" gate are static (no proration — each
  // workspace is its own subscription, full $499 today), so we never block the
  // copy on this call; it only decides Business-vs-Starter-vs-no-card.
  async function runAcknowledgePreview() {
    setAckState("loading");
    setError(null);
    try {
      const { data, error: invokeError } = await supabase.functions.invoke("create-workspace", {
        body: { mode: "preview" },
      });
      if (invokeError) {
        setAckState("error");
        return;
      }
      const resp = data as {
        ok: boolean;
        eligible?: boolean;
        reason?: string | null;
        count?: number;
        cap?: number;
      };
      if (!resp.ok) {
        setAckState("error");
        return;
      }
      if (resp.eligible === true) {
        // Eligibility only — do NOT cache card details here. The binding confirm
        // panel re-fetches via runPreview() at name → confirm so the card it
        // shows is the live default card, never a stale snapshot from this gate.
        setAckState("ready");
        return;
      }
      // Not eligible — branch on the typed reason into a specific gate variant.
      setError({ reason: resp.reason ?? "not_eligible", count: resp.count, cap: resp.cap });
      switch (resp.reason) {
        case "not_eligible":
          setAckState("starter");
          break;
        case "no_card_on_file":
        case "no_customer":
          setAckState("no_card");
          break;
        case "cap_reached":
          setAckState("cap");
          break;
        default:
          setAckState("error");
      }
    } catch {
      setAckState("error");
    }
  }

  // Advance from the awareness gate to the name step. The eligibility call
  // already ran, so the name → confirm transition reuses it (no second preview).
  function handleAckContinue() {
    if (suppress) {
      try {
        localStorage.setItem(ACK_SUPPRESS_KEY, "1");
      } catch {
        // Storage blocked — the gate just shows again next time. No-op.
      }
    }
    setStep("name");
  }

  async function runPreview(workspaceIdForResume?: string) {
    setStep("preview");
    setError(null);
    try {
      // NOTE: do NOT log the response body — the resume branch carries the
      // existing PI clientSecret, and discipline lives here.
      const body: { mode: "preview"; workspaceId?: string } = { mode: "preview" };
      if (workspaceIdForResume) body.workspaceId = workspaceIdForResume;
      const { data, error: invokeError } = await supabase.functions.invoke("create-workspace", {
        body,
      });
      if (invokeError) {
        setError({ reason: "stripe_unverified", message: invokeError.message });
        setStep("error");
        return;
      }
      const resp = data as {
        ok: boolean;
        eligible?: boolean;
        reason?: string | null;
        methodLabel?: string | null;
        cardLast4?: string | null;
        cardBrand?: string | null;
        priceMonthly?: number;
        chargedToday?: number;
        count?: number;
        cap?: number;
        resume?: { workspaceId: string; name: string; clientSecret: string } | null;
      };
      // Resume branch: the server returned an existing-PI clientSecret. Skip
      // the name step entirely and route straight to confirm with the resumed
      // workspace's name + the existing PaymentIntent secret.
      if (workspaceIdForResume) {
        if (!resp.ok || !resp.resume) {
          setError({ reason: resp.reason ?? "resume_unavailable" });
          setStep("error");
          return;
        }
        clientSecretRef.current = resp.resume.clientSecret;
        setCreatedWorkspaceId(resp.resume.workspaceId);
        setName(resp.resume.name);
        setPreview({
          methodLabel: resp.methodLabel ?? null,
          cardLast4: resp.cardLast4 ?? null,
          cardBrand: resp.cardBrand ?? null,
          priceMonthly: resp.priceMonthly ?? 499,
          chargedToday: resp.chargedToday ?? 499,
          count: resp.count ?? 0,
          cap: resp.cap ?? 10,
        });
        setStep("confirm");
        return;
      }
      if (!resp.ok || resp.eligible !== true) {
        setError({
          reason: resp.reason ?? "not_eligible",
          count: resp.count,
          cap: resp.cap,
        });
        setStep("error");
        return;
      }
      setPreview({
        methodLabel: resp.methodLabel ?? null,
        cardLast4: resp.cardLast4 ?? null,
        cardBrand: resp.cardBrand ?? null,
        priceMonthly: resp.priceMonthly ?? 499,
        chargedToday: resp.chargedToday ?? 499,
        count: resp.count ?? 0,
        cap: resp.cap ?? 10,
      });
      setStep("confirm");
    } catch (e) {
      setError({ reason: "stripe_unverified", message: e instanceof Error ? e.message : String(e) });
      setStep("error");
    }
  }

  async function runConfirm() {
    setStep("confirming");
    setError(null);

    let workspaceId: string;
    let clientSecret: string | null;
    let piStatus: string | null;

    if (isResume) {
      // Resume path — workspace + subscription already exist. The preview call
      // populated clientSecretRef + createdWorkspaceId. Skip the server confirm
      // (a re-call would create a duplicate sub) and drive payment confirmation
      // directly on the existing PI.
      if (!createdWorkspaceId || !clientSecretRef.current) {
        setError({ reason: "resume_unavailable" });
        setStep("error");
        return;
      }
      workspaceId = createdWorkspaceId;
      clientSecret = clientSecretRef.current;
      piStatus = null; // unknown — let the payment confirmation branch handle it
    } else {
      // 1) Server: create the workspace + an incomplete subscription, return
      //    the PaymentIntent client_secret. We deliberately do not log `data`.
      const { data, error: invokeError } = await supabase.functions.invoke("create-workspace", {
        body: {
          mode: "confirm",
          name: name.trim(),
          idempotencyKey: idempotencyKeyRef.current,
        },
      });
      if (invokeError) {
        setError({ reason: "stripe_error", message: invokeError.message });
        setStep("error");
        return;
      }
      const resp = data as ConfirmResult;
      if (!resp.ok) {
        setError({ reason: resp.reason ?? "stripe_error", message: resp.error });
        setStep("error");
        return;
      }
      if (!resp.workspaceId) {
        setError({ reason: "stripe_error", message: "Server did not return a workspaceId" });
        setStep("error");
        return;
      }
      setCreatedWorkspaceId(resp.workspaceId);
      // Idempotent replay (duplicate) — the server returned the prior workspace.
      if (resp.status === "duplicate") {
        // Treat as activating; poll the live state and let the existing branches resolve.
        void pollForActivation(resp.workspaceId);
        return;
      }
      workspaceId = resp.workspaceId;
      piStatus = resp.paymentIntentStatus ?? null;
      clientSecret = resp.clientSecret ?? null;
      clientSecretRef.current = clientSecret;
    }

    // 2) If the PI is already succeeded (no-3DS card), go straight to polling.
    if (piStatus === "succeeded") {
      clientSecretRef.current = null;
      void pollForActivation(workspaceId);
      return;
    }

    // 3) Otherwise we need payment confirmation to drive the PI to succeeded.
    if (!clientSecret) {
      setError({ reason: "stripe_error", message: "Missing PaymentIntent client_secret" });
      setStep("error");
      return;
    }
    setStep("three_ds");
    const stripePromise = getStripe();
    if (!stripePromise) {
      setError({ reason: "unavailable" });
      setStep("error");
      return;
    }
    const stripe = await stripePromise;
    if (!stripe) {
      setError({ reason: "unavailable" });
      setStep("error");
      return;
    }

    const confirmResult = await confirmSavedMethodPayment(stripe, clientSecret);

    if (confirmResult.error) {
      // Recovery discipline: re-fetch the PI before deciding to cancel — a
      // network error AFTER Stripe succeeded the PI would otherwise tear down
      // a paid workspace.
      try {
        const retrieve = await stripe.retrievePaymentIntent(clientSecret);
        const status = retrieve.paymentIntent?.status;
        if (status === "succeeded") {
          clientSecretRef.current = null;
          void pollForActivation(workspaceId);
          return;
        }
      } catch {
        // Fall through to cancel — Stripe was unreachable both times.
      }

      // PI is genuinely not succeeded; clean up the orphan workspace.
      // Skip cancel in resume mode — the orphan already existed; tearing it
      // down here would erase the user's retry path.
      if (!isResume) {
        await supabase.functions
          .invoke("create-workspace", { body: { mode: "cancel", workspaceId } })
          .catch(() => {});
      }
      clientSecretRef.current = null;

      const reason =
        confirmResult.error.code === "payment_intent_authentication_failure" ||
        confirmResult.error.code === "card_declined"
          ? "payment_failed"
          : "three_ds_canceled";
      setError({ reason, message: confirmResult.error.message });
      setStep("error");
      return;
    }

    // Success — clear the secret from memory immediately, then poll.
    clientSecretRef.current = null;
    void pollForActivation(workspaceId);
  }

  // Narrow poll on the new workspace's subscription_status — RLS-owner-readable.
  // Cleans up its own interval on unmount via the abort flag in the closure.
  async function pollForActivation(workspaceId: string) {
    setStep("activating");
    let elapsed = 0;
    let aborted = false;
    const cleanup = () => {
      aborted = true;
    };
    // Stash the cleanup so the unmount-effect below can call it on dialog close.
    pollCleanupRef.current = cleanup;

    while (!aborted && elapsed < POLL_TIMEOUT_MS) {
      const { data: row } = await supabase
        .from("workspaces")
        .select("id, plan, subscription_status")
        .eq("id", workspaceId)
        .maybeSingle();
      const r = row as { plan: string | null; subscription_status: string | null } | null;
      if (
        r &&
        r.plan === "business" &&
        r.subscription_status &&
        ["active", "trialing"].includes(r.subscription_status)
      ) {
        if (aborted) return;
        setStep("activated");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      elapsed += POLL_INTERVAL_MS;
    }
    if (aborted) return;

    // Timeout — branch the copy honestly: did the PI actually succeed?
    // clientSecretRef is null by now (we cleared after payment confirmation);
    // infer "paid" from workspace state instead — any non-NULL, non-incomplete
    // subscription_status is evidence the Stripe webhook is en route.
    let paid = false;
    try {
      const { data: row } = await supabase
        .from("workspaces")
        .select("subscription_status")
        .eq("id", workspaceId)
        .maybeSingle();
      const status = (row as { subscription_status: string | null } | null)?.subscription_status ?? null;
      paid = status !== null && status !== "incomplete" && status !== "incomplete_expired";
    } catch {
      paid = false;
    }
    setStep(paid ? "timeout_paid" : "timeout_unpaid");
  }

  // Cleanup pollers on unmount / dialog close. pollCleanupRef declared at the
  // top of the component (above pollForActivation) so the function's first read
  // isn't a forward reference.
  useEffect(() => {
    if (!open) {
      pollCleanupRef.current?.();
      pollCleanupRef.current = null;
    }
    return () => {
      pollCleanupRef.current?.();
    };
  }, [open]);

  function handleSwitchTo() {
    if (createdWorkspaceId) {
      void switchWorkspace(createdWorkspaceId);
    }
    onOpenChange(false);
  }

  function handleStayHere() {
    onOpenChange(false);
  }

  function handleRetryAfterDecline() {
    setError(null);
    setStep("confirm");
  }

  // -------- Rendering --------
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onEscapeKeyDown={(e) => isInFlight && e.preventDefault()}
        onInteractOutside={(e) => isInFlight && e.preventDefault()}
      >
        {/* Step 0 — price-awareness gate. Fires before the name step so the
            owner learns the money stake before investing in a name. NOT the
            binding consent: the confirm step still shows the real card + exact
            charge and is never suppressible. */}
        {step === "acknowledge" ? (
          ackState === "loading" ? (
            <>
              <DialogHeader>
                {/* Neutral title while eligibility is unknown — don't assert
                    "adds to your subscription" to a user who may be on Starter. */}
                <DialogTitle>{t("workspace.create.dialog_title")}</DialogTitle>
                <DialogDescription>{t("workspace.create.acknowledge_loading")}</DialogDescription>
              </DialogHeader>
              <div className="flex justify-center py-6">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            </>
          ) : ackState === "ready" ? (
            <>
              <DialogHeader>
                <DialogTitle>{t("workspace.create.acknowledge_title")}</DialogTitle>
                <DialogDescription>{t("workspace.create.acknowledge_intro")}</DialogDescription>
              </DialogHeader>
              <ul className="space-y-2 py-2 text-sm">
                <li>• {t("workspace.create.acknowledge_bullet_today")}</li>
                <li>
                  •{" "}
                  {t("workspace.create.acknowledge_bullet_recurring", {
                    day: renewalDayLabel(lang),
                  })}
                </li>
                <li>• {t("workspace.create.confirm_bullet_quota")}</li>
              </ul>
              <p className="text-xs text-muted-foreground">
                {t("workspace.create.acknowledge_next_step")}
              </p>
              <label className="flex items-center gap-2 pt-2 cursor-pointer select-none">
                <Checkbox
                  checked={suppress}
                  onCheckedChange={(v) => setSuppress(v === true)}
                  aria-label={t("workspace.create.acknowledge_suppress")}
                />
                <span className="text-xs text-muted-foreground">
                  {t("workspace.create.acknowledge_suppress")}
                </span>
              </label>
              <DialogFooter>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  {t("workspace.create.dialog_cancel")}
                </Button>
                <Button onClick={handleAckContinue} autoFocus>
                  {t("workspace.create.dialog_continue")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            // starter / no_card / cap / error — route or inform; never strand.
            <>
              <DialogHeader>
                <DialogTitle>
                  {ackState === "starter"
                    ? t("workspace.create.error_not_eligible_title")
                    : ackState === "no_card"
                      ? t("workspace.create.error_no_card_title")
                      : ackState === "cap"
                        ? t("workspace.create.error_cap_reached_title")
                        : t("workspace.create.error_stripe_unverified_title")}
                </DialogTitle>
                <DialogDescription>
                  {ackState === "starter"
                    ? t("workspace.create.error_not_eligible_body")
                    : ackState === "no_card"
                      ? t("workspace.create.error_no_card_body")
                      : ackState === "cap"
                        ? t("workspace.create.error_cap_reached_body", {
                            count: error?.count,
                            cap: error?.cap,
                          })
                        : t("workspace.create.error_stripe_unverified_body")}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  {t("workspace.create.timeout_close")}
                </Button>
                {ackState === "starter" ? (
                  <Button
                    onClick={() => {
                      onOpenChange(false);
                      navigate("/app/settings/account?tab=billing");
                    }}
                  >
                    {t("workspace.create.error_not_eligible_cta")}
                  </Button>
                ) : ackState === "no_card" ? (
                  <Button
                    onClick={() => {
                      onOpenChange(false);
                      navigate("/app/settings/account?tab=billing");
                    }}
                  >
                    {t("workspace.create.error_no_card_cta")}
                  </Button>
                ) : ackState === "cap" ? (
                  // The cap copy tells the owner to delete a workspace — give
                  // them the door to do it instead of a Close-only dead-end.
                  <Button
                    onClick={() => {
                      onOpenChange(false);
                      navigate("/app/settings/workspaces");
                    }}
                  >
                    {t("workspace.create.manage_link")}
                  </Button>
                ) : ackState === "error" ? (
                  <Button variant="secondary" onClick={() => void runAcknowledgePreview()}>
                    {t("workspace.create.acknowledge_retry")}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          )
        ) : null}

        {/* In resume mode there is no name step — the dialog opens directly into
            preview-in-flight, then into the confirm panel rendered below. */}
        {(step === "name" || (step === "preview" && !isResume)) ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.create.dialog_title")}</DialogTitle>
              <DialogDescription>{t("workspace.create.confirm_intro")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <Label htmlFor="new-ws-name">{t("workspace.create.dialog_name_label")}</Label>
              <Input
                id="new-ws-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 100))}
                placeholder={t("workspace.create.dialog_name_placeholder")}
                disabled={step === "preview"}
                maxLength={100}
              />
              <p className="text-xs text-muted-foreground">{t("workspace.create.dialog_name_help")}</p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={step === "preview"}>
                {t("workspace.create.dialog_cancel")}
              </Button>
              <Button
                onClick={() => runPreview()}
                disabled={step === "preview" || name.trim().length < 1}
              >
                {step === "preview" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("workspace.create.confirm_button_loading")}
                  </>
                ) : (
                  t("workspace.create.dialog_continue")
                )}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {/* Resume-mode in-flight preview: show a loader while we fetch the
            existing PaymentIntent. No name input — name is server-supplied. */}
        {step === "preview" && isResume ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.create.activating_title", { name: name.trim() || "" })}</DialogTitle>
              <DialogDescription>{t("workspace.create.confirm_button_loading")}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-6">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </>
        ) : null}

        {(step === "confirm" || step === "confirming" || step === "three_ds") && preview ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.create.confirm_title", { name: name.trim() })}</DialogTitle>
              <DialogDescription>
                {isResume
                  ? t("workspace.create.resume_dialog_intro")
                  : t("workspace.create.confirm_intro")}
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-2 py-2 text-sm">
              {!isResume ? <li>• {t("workspace.create.confirm_bullet_today")}</li> : null}
              <li>
                •{" "}
                {t("workspace.create.confirm_bullet_recurring", {
                  method: preview.methodLabel ?? t("workspace.create.method_on_file_fallback"),
                })}
              </li>
              <li>• {t("workspace.create.confirm_bullet_quota")}</li>
            </ul>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isInFlight}>
                {t("workspace.create.dialog_cancel")}
              </Button>
              <Button onClick={runConfirm} disabled={isInFlight}>
                {isInFlight ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("workspace.create.confirm_button_loading")}
                  </>
                ) : isResume ? (
                  t("workspace.create.resume_button")
                ) : (
                  t("workspace.create.confirm_button")
                )}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "activating" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.create.activating_title", { name: name.trim() })}</DialogTitle>
              <DialogDescription>{t("workspace.create.activating_body")}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-6">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </>
        ) : null}

        {step === "activated" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.create.activated_title", { name: name.trim() })}</DialogTitle>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleStayHere}>
                {t("workspace.create.activated_stay")}
              </Button>
              <Button onClick={handleSwitchTo} autoFocus>
                {t("workspace.create.activated_switch")}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "timeout_paid" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.create.timeout_paid_title")}</DialogTitle>
              <DialogDescription>{t("workspace.create.timeout_paid_body")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {t("workspace.create.timeout_close")}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "timeout_unpaid" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("workspace.create.timeout_unpaid_title")}</DialogTitle>
              <DialogDescription>{t("workspace.create.timeout_unpaid_body")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {t("workspace.create.timeout_close")}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "error" && error ? (
          <ErrorPane
            error={error}
            t={t}
            onClose={() => onOpenChange(false)}
            onRetry={
              error.reason === "payment_failed" || error.reason === "three_ds_canceled"
                ? handleRetryAfterDecline
                : undefined
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ErrorPane({
  error,
  t,
  onClose,
  onRetry,
}: {
  error: ErrorState;
  t: ReturnType<typeof useAppTranslation>["t"];
  onClose: () => void;
  onRetry?: () => void;
}) {
  const { reason } = error;

  // Map server reason -> i18n keys + CTAs. Every branch produces its own,
  // honest copy. The "No charge was made" safe-line is mandatory on decline.
  let titleKey = "workspace.create.error_unavailable_title";
  let bodyKey = "workspace.create.error_unavailable_body";
  let extraSafeLine: string | null = null;
  let primaryHref: string | null = null;
  let primaryLabelKey: string | null = null;

  switch (reason) {
    case "not_eligible":
      titleKey = "workspace.create.error_not_eligible_title";
      bodyKey = "workspace.create.error_not_eligible_body";
      // Always-render pattern: a Starter / non-Business user clicking the
      // "+ New workspace" entry lands here. Route to the upgrade page (parity
      // with the acknowledge-gate "starter" variant — same outcome, one door).
      primaryHref = "/app/settings/account?tab=billing";
      primaryLabelKey = "workspace.create.error_not_eligible_cta";
      break;
    case "cap_reached":
      titleKey = "workspace.create.error_cap_reached_title";
      bodyKey = "workspace.create.error_cap_reached_body";
      break;
    case "no_card_on_file":
      titleKey = "workspace.create.error_no_card_title";
      bodyKey = "workspace.create.error_no_card_body";
      primaryHref = "/app/settings/account?tab=billing";
      primaryLabelKey = "workspace.create.error_no_card_cta";
      break;
    case "no_customer":
      titleKey = "workspace.create.error_no_customer_title";
      bodyKey = "workspace.create.error_no_customer_body";
      primaryHref = "/app/settings/account?tab=billing";
      primaryLabelKey = "workspace.create.error_no_card_cta";
      break;
    case "stripe_unverified":
    case "stripe_error":
      titleKey = "workspace.create.error_stripe_unverified_title";
      bodyKey = "workspace.create.error_stripe_unverified_body";
      break;
    case "payment_failed":
      titleKey = "workspace.create.error_payment_failed_title";
      bodyKey = "workspace.create.error_payment_failed_safe_line";
      extraSafeLine = error.message ?? null;
      primaryHref = "/app/settings/account?tab=billing";
      primaryLabelKey = "workspace.create.error_payment_failed_cta";
      break;
    case "three_ds_canceled":
      titleKey = "workspace.create.error_3ds_canceled_title";
      bodyKey = "workspace.create.error_3ds_canceled_body";
      break;
    case "resume_unavailable":
      titleKey = "workspace.create.resume_unavailable_title";
      bodyKey = "workspace.create.resume_unavailable_body";
      break;
    case "unavailable":
    default:
      titleKey = "workspace.create.error_unavailable_title";
      bodyKey = "workspace.create.error_unavailable_body";
      break;
  }

  const navigate = useNavigate();

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t(titleKey, error.reason === "cap_reached" ? { count: error.count, cap: error.cap } : {})}
        </DialogTitle>
        <DialogDescription>
          {t(bodyKey, error.reason === "cap_reached" ? { count: error.count, cap: error.cap } : {})}
        </DialogDescription>
      </DialogHeader>
      {/* extraSafeLine renders Stripe's decline string. Render as TEXT only:
          React auto-escapes children, so it's safe today. Do NOT migrate this
          to <Trans>, Markdown, or dangerouslySetInnerHTML without sanitization. */}
      {extraSafeLine ? (
        <p className="text-sm text-muted-foreground py-2">{extraSafeLine}</p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("workspace.create.timeout_close")}
        </Button>
        {onRetry ? (
          <Button onClick={onRetry} variant="secondary">
            {t("workspace.create.error_3ds_retry")}
          </Button>
        ) : null}
        {primaryHref && primaryLabelKey ? (
          <Button
            onClick={() => {
              onClose();
              navigate(primaryHref!);
            }}
          >
            {t(primaryLabelKey)}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
