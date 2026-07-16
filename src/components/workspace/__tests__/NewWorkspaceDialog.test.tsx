// @vitest-environment jsdom
import "./_jsdomPolyfills";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";

// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.2, §P2.3, §P2.11.
//
// What we pin (per spec §P2.8 test plan):
//   1. The idempotencyKey stays stable across a retry within the same dialog
//      instance — i.e. a second confirm call reuses the SAME key the first
//      confirm sent. Different dialog opens get FRESH keys.
//   2. Buttons are disabled during the in-flight payment window
//      (confirming / three_ds / activating).
//   3. Each error branch renders distinct copy via the i18n keys.
//   4. 3DS requires_action -> confirmPayment success -> activating ->
//      activated (poll observes Business+active).
//   5. confirmPayment ERROR -> cancel mode called (when PI is genuinely
//      not succeeded) -> error branch.
//
// We mock supabase, @stripe/stripe-js, getStripe, useApp, useAppTranslation.

// --- Mocks ----------------------------------------------------------------

const invokeMock = vi.fn();
const fromMock = vi.fn();
const switchWorkspaceMock = vi.fn();
const confirmPaymentMock = vi.fn();
const retrievePaymentIntentMock = vi.fn();
const getStripeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => getStripeMock(),
}));

// useNavigate is read at component-mount time for the ErrorPane's primary
// CTA — we mock it to avoid wrapping every test in MemoryRouter.
const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    switchWorkspace: switchWorkspaceMock,
    availableWorkspaces: [],
    workspace: null,
  }),
}));

// Mutable so a single test can flip the UI language (Spanish) to exercise the
// renewalDayLabel cardinal-vs-ordinal branch. Defaults to "en"; reset in
// afterEach so it never leaks across tests.
let langValue = "en";
vi.mock("@/hooks/useAppTranslation", () => ({
  useAppTranslation: () => ({
    get lang() {
      return langValue;
    },
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        // Surface params so we can assert on them.
        const params = Object.entries(opts)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(",");
        return params ? `${key}(${params})` : key;
      }
      return key;
    },
  }),
}));

import { NewWorkspaceDialog, ACK_SUPPRESS_KEY } from "../NewWorkspaceDialog";

// --- Helpers --------------------------------------------------------------

function buildFromBuilder(row: unknown) {
  // Mirror PostgREST chain shape: .from().select().eq().maybeSingle().
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve({ data: row, error: null })),
  };
  return builder;
}

function setupStripeMock() {
  const stripeInstance = {
    confirmPayment: confirmPaymentMock,
    retrievePaymentIntent: retrievePaymentIntentMock,
  };
  getStripeMock.mockReturnValue(Promise.resolve(stripeInstance));
  return stripeInstance;
}

beforeEach(() => {
  invokeMock.mockReset();
  fromMock.mockReset();
  switchWorkspaceMock.mockReset();
  confirmPaymentMock.mockReset();
  retrievePaymentIntentMock.mockReset();
  getStripeMock.mockReset();
  navigateMock.mockReset();
  setupStripeMock();
  // Default: workspaces table read returns an active Business row (poll succeeds).
  fromMock.mockImplementation(() =>
    buildFromBuilder({ id: "ws-1", plan: "business", subscription_status: "active" }),
  );
  // Suppress the price-awareness gate by default so the existing flow tests
  // open straight at the name step. The dedicated gate describe block clears
  // this in its own beforeEach to exercise the gate itself.
  localStorage.setItem(ACK_SUPPRESS_KEY, "1");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  langValue = "en";
});

// Convenience: drive the dialog to step 2 (confirm) by typing a name and
// receiving a preview response.
async function advanceToConfirmStep(name = "Acme Inc.") {
  invokeMock.mockResolvedValueOnce({
    data: {
      ok: true,
      eligible: true,
      cardLast4: "4242",
      cardBrand: "visa",
      priceMonthly: 499,
      chargedToday: 499,
      count: 1,
      cap: 10,
    },
    error: null,
  });
  const nameInput = screen.getByLabelText(/dialog_name_label/);
  fireEvent.change(nameInput, { target: { value: name } });
  const continueBtn = screen.getByRole("button", { name: /dialog_continue/ });
  await act(async () => {
    fireEvent.click(continueBtn);
  });
}

// --- Tests ----------------------------------------------------------------

describe("NewWorkspaceDialog — idempotency key stability", () => {
  it("reuses the same idempotencyKey on a retry within one dialog instance", async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();

    // First confirm — server returns a Stripe error so the dialog stays
    // mounted and the user can retry. The retry must send the SAME key.
    invokeMock.mockResolvedValueOnce({
      data: { ok: false, reason: "stripe_error", error: "boom" },
      error: null,
    });
    const confirmBtn = screen.getByRole("button", { name: /confirm_button/ });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Inspect the body of the second invoke call (the confirm one).
    const firstConfirmCall = invokeMock.mock.calls.find(
      (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "confirm",
    );
    expect(firstConfirmCall).toBeDefined();
    const firstKey = (firstConfirmCall![1] as { body: { idempotencyKey: string } }).body
      .idempotencyKey;
    expect(firstKey).toMatch(/^[a-f0-9]{32}$/);

    // Now retry — the error pane has an i18n "error_3ds_retry" button only for
    // payment_failed / three_ds_canceled. For stripe_error, the only path back
    // is to close and reopen, which (per spec) resets the key. So instead we
    // test the same-instance retry via a payment_failed -> retry path.
    cleanup();
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();

    invokeMock.mockResolvedValueOnce({
      data: { ok: false, reason: "payment_failed", error: "card declined" },
      error: null,
    });
    const confirmBtn2 = screen.getByRole("button", { name: /confirm_button/ });
    await act(async () => {
      fireEvent.click(confirmBtn2);
    });

    const firstKeyInThisInstance = (
      invokeMock.mock.calls.filter(
        (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "confirm",
      ).slice(-1)[0]![1] as { body: { idempotencyKey: string } }
    ).body.idempotencyKey;

    // Click the retry button -> returns to the confirm step in the SAME instance.
    const retryBtn = await screen.findByRole("button", { name: /error_3ds_retry/ });
    fireEvent.click(retryBtn);

    invokeMock.mockResolvedValueOnce({
      data: { ok: false, reason: "stripe_error", error: "boom2" },
      error: null,
    });
    const confirmBtn3 = await screen.findByRole("button", { name: /confirm_button/ });
    await act(async () => {
      fireEvent.click(confirmBtn3);
    });

    const secondKeyInThisInstance = (
      invokeMock.mock.calls.filter(
        (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "confirm",
      ).slice(-1)[0]![1] as { body: { idempotencyKey: string } }
    ).body.idempotencyKey;

    expect(secondKeyInThisInstance).toBe(firstKeyInThisInstance);
  });

  it("a closed-and-reopened dialog gets a FRESH idempotencyKey", async () => {
    // Open #1: capture the key.
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />,
    );
    await advanceToConfirmStep();
    invokeMock.mockResolvedValueOnce({
      data: { ok: false, reason: "stripe_error", error: "x" },
      error: null,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm_button/ }));
    });
    const callsRound1 = invokeMock.mock.calls.filter(
      (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "confirm",
    );
    const key1 = (callsRound1[0]![1] as { body: { idempotencyKey: string } }).body
      .idempotencyKey;

    // Close.
    rerender(<NewWorkspaceDialog open={false} onOpenChange={onOpenChange} />);

    // Open #2 — fresh key.
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({
      data: {
        ok: true,
        eligible: true,
        cardLast4: "4242",
        cardBrand: "visa",
        priceMonthly: 499,
        chargedToday: 499,
        count: 1,
        cap: 10,
      },
      error: null,
    });
    rerender(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);
    const nameInput = screen.getByLabelText(/dialog_name_label/);
    fireEvent.change(nameInput, { target: { value: "Beta Inc." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dialog_continue/ }));
    });
    invokeMock.mockResolvedValueOnce({
      data: { ok: false, reason: "stripe_error", error: "y" },
      error: null,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm_button/ }));
    });
    const callsRound2 = invokeMock.mock.calls.filter(
      (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "confirm",
    );
    const key2 = (callsRound2[0]![1] as { body: { idempotencyKey: string } }).body
      .idempotencyKey;

    expect(key2).not.toBe(key1);
    expect(key2).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("NewWorkspaceDialog — error branches render the correct copy", () => {
  async function runPreviewError(reason: string, count?: number, cap?: number) {
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    invokeMock.mockResolvedValueOnce({
      data: { ok: true, eligible: false, reason, count, cap },
      error: null,
    });
    const nameInput = screen.getByLabelText(/dialog_name_label/);
    fireEvent.change(nameInput, { target: { value: "Acme" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dialog_continue/ }));
    });
  }

  it("not_eligible -> shows error_not_eligible copy", async () => {
    await runPreviewError("not_eligible");
    expect(await screen.findByText("workspace.create.error_not_eligible_title")).toBeTruthy();
  });

  it("cap_reached -> shows error_cap_reached copy with count + cap params", async () => {
    await runPreviewError("cap_reached", 10, 10);
    // The mock t() echoes params so we can assert they were threaded through.
    const title = await screen.findByText(/workspace.create.error_cap_reached_title/);
    expect(title.textContent).toContain("count=10");
    expect(title.textContent).toContain("cap=10");
  });

  it("no_card_on_file -> shows error_no_card copy + 'Open billing' CTA", async () => {
    await runPreviewError("no_card_on_file");
    expect(await screen.findByText("workspace.create.error_no_card_title")).toBeTruthy();
    expect(screen.getByRole("button", { name: /error_no_card_cta/ })).toBeTruthy();
  });

  it("no_customer -> shows error_no_customer copy", async () => {
    await runPreviewError("no_customer");
    expect(await screen.findByText("workspace.create.error_no_customer_title")).toBeTruthy();
  });

  it("stripe_error during confirm -> shows error_stripe_unverified copy", async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();
    invokeMock.mockResolvedValueOnce({
      data: { ok: false, reason: "stripe_error", error: "network" },
      error: null,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm_button/ }));
    });
    expect(
      await screen.findByText("workspace.create.error_stripe_unverified_title"),
    ).toBeTruthy();
  });
});

describe("NewWorkspaceDialog — 3DS success flow", () => {
  it("requires_action -> confirmPayment success -> Activating -> Activated", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();

    // Server creates workspace + incomplete sub; returns clientSecret.
    invokeMock.mockResolvedValueOnce({
      data: {
        ok: true,
        workspaceId: "ws-1",
        clientSecret: "pi_secret_xyz",
        paymentIntentStatus: "requires_action",
      },
      error: null,
    });
    // Stripe.js confirms the payment cleanly.
    confirmPaymentMock.mockResolvedValueOnce({
      paymentIntent: { status: "succeeded" },
      error: undefined,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm_button/ }));
    });

    // Eventually flips to activated. The poll loop is async + setTimeout-driven;
    // with shouldAdvanceTime: true, advancing real time still ticks it.
    await waitFor(
      () => {
        expect(
          screen.queryByText(/workspace.create.activated_title/),
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );

    // confirmPayment was called with the clientSecret, method-agnostically
    // (#161): no Elements, saved method of any type, in-page unless a redirect
    // is genuinely required.
    expect(confirmPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "pi_secret_xyz", redirect: "if_required" }),
    );

    // Switch button (autoFocus) and Stay button rendered.
    expect(screen.getByRole("button", { name: /activated_switch/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /activated_stay/ })).toBeTruthy();
  });

  it("confirm with paymentIntentStatus='succeeded' skips 3DS and goes straight to activating", async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();

    invokeMock.mockResolvedValueOnce({
      data: {
        ok: true,
        workspaceId: "ws-1",
        clientSecret: "pi_secret_xyz",
        paymentIntentStatus: "succeeded",
      },
      error: null,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm_button/ }));
    });

    // confirmPayment should NOT have been called.
    expect(confirmPaymentMock).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.queryByText(/workspace.create.activated_title/)).not.toBeNull(),
    );
  });
});

describe("NewWorkspaceDialog — 3DS error -> retrievePaymentIntent guard -> cancel", () => {
  it("on confirmPayment error AND PI is NOT succeeded, calls cancel mode", async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();

    invokeMock.mockResolvedValueOnce({
      data: {
        ok: true,
        workspaceId: "ws-1",
        clientSecret: "pi_secret_xyz",
        paymentIntentStatus: "requires_action",
      },
      error: null,
    });
    confirmPaymentMock.mockResolvedValueOnce({
      error: { code: "card_declined", message: "Your card was declined." },
    });
    retrievePaymentIntentMock.mockResolvedValueOnce({
      paymentIntent: { status: "requires_payment_method" },
    });
    // Cancel mode invocation (third call to invoke).
    invokeMock.mockResolvedValueOnce({ data: { ok: true }, error: null });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm_button/ }));
    });

    // Verify cancel mode was called with the workspaceId.
    await waitFor(() => {
      const cancelCall = invokeMock.mock.calls.find(
        (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "cancel",
      );
      expect(cancelCall).toBeDefined();
      const body = (cancelCall![1] as { body: { workspaceId: string } }).body;
      expect(body.workspaceId).toBe("ws-1");
    });

    // The payment_failed error branch renders.
    expect(
      await screen.findByText("workspace.create.error_payment_failed_title"),
    ).toBeTruthy();
  });

  it("on confirmPayment error BUT PI is succeeded (network blip after success), does NOT cancel", async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();

    invokeMock.mockResolvedValueOnce({
      data: {
        ok: true,
        workspaceId: "ws-1",
        clientSecret: "pi_secret_xyz",
        paymentIntentStatus: "requires_action",
      },
      error: null,
    });
    // Stripe.js threw network error AFTER PI succeeded on Stripe's side.
    confirmPaymentMock.mockResolvedValueOnce({
      error: { code: "api_connection_error", message: "Network error" },
    });
    retrievePaymentIntentMock.mockResolvedValueOnce({
      paymentIntent: { status: "succeeded" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm_button/ }));
    });

    // Cancel must NOT have been called — we'd tear down a paid workspace.
    await waitFor(() => {
      const cancelCall = invokeMock.mock.calls.find(
        (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "cancel",
      );
      expect(cancelCall).toBeUndefined();
    });
  });
});

describe("NewWorkspaceDialog — price-awareness gate (before name)", () => {
  // The gate is the default (un-suppressed) entry point. Clear the suppression
  // the module beforeEach sets so these tests see the gate.
  beforeEach(() => {
    localStorage.removeItem(ACK_SUPPRESS_KEY);
  });

  function mockEligibility(resp: Record<string, unknown>) {
    invokeMock.mockResolvedValueOnce({ data: resp, error: null });
  }

  it("eligible Business owner sees the gate, then Continue advances to the name step", async () => {
    mockEligibility({
      ok: true,
      eligible: true,
      cardLast4: "4242",
      cardBrand: "visa",
      priceMonthly: 499,
      chargedToday: 499,
      count: 1,
      cap: 10,
    });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    // Gate copy is shown, name input is NOT yet present.
    expect(await screen.findByText("workspace.create.acknowledge_title")).toBeTruthy();
    expect(screen.queryByLabelText(/dialog_name_label/)).toBeNull();
    // The eligibility check used mode:"preview" with NO name.
    const previewCall = invokeMock.mock.calls.find(
      (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "preview",
    );
    expect(previewCall).toBeDefined();
    expect((previewCall![1] as { body: Record<string, unknown> }).body).not.toHaveProperty("name");

    // Continue → name step.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dialog_continue/ }));
    });
    expect(screen.getByLabelText(/dialog_name_label/)).toBeTruthy();
  });

  it("re-fetches preview on name → confirm so the confirm panel shows the LIVE card, not a gate snapshot", async () => {
    // Gate eligibility call (no card needed for the gate display).
    mockEligibility({ ok: true, eligible: true, count: 1, cap: 10 });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    await screen.findByText("workspace.create.acknowledge_title");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dialog_continue/ }));
    });
    // The confirm step pulls a FRESH preview (live card), not the gate snapshot.
    mockEligibility({
      ok: true,
      eligible: true,
      cardLast4: "4242",
      cardBrand: "visa",
      priceMonthly: 499,
      chargedToday: 499,
      count: 1,
      cap: 10,
    });
    fireEvent.change(screen.getByLabelText(/dialog_name_label/), {
      target: { value: "Acme Inc." },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dialog_continue/ }));
    });
    expect(await screen.findByText(/workspace.create.confirm_title/)).toBeTruthy();
    // TWO preview calls: the gate eligibility check + the confirm-step refresh.
    const previewCalls = invokeMock.mock.calls.filter(
      (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "preview",
    );
    expect(previewCalls.length).toBe(2);
  });

  it("the cap variant offers a Manage-workspaces escape (not a Close-only dead-end)", async () => {
    mockEligibility({ ok: true, eligible: false, reason: "cap_reached", count: 10, cap: 10 });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    await screen.findByText(/workspace.create.error_cap_reached_title/);
    const manageBtn = screen.getByRole("button", { name: /workspace.create.manage_link/ });
    fireEvent.click(manageBtn);
    expect(navigateMock).toHaveBeenCalledWith("/app/settings/workspaces");
  });

  it("the suppress checkbox writes the localStorage flag on Continue", async () => {
    mockEligibility({
      ok: true,
      eligible: true,
      cardLast4: "4242",
      cardBrand: "visa",
      priceMonthly: 499,
      chargedToday: 499,
      count: 1,
      cap: 10,
    });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    await screen.findByText("workspace.create.acknowledge_title");
    fireEvent.click(screen.getByLabelText(/acknowledge_suppress/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dialog_continue/ }));
    });
    expect(localStorage.getItem(ACK_SUPPRESS_KEY)).toBe("1");
  });

  it("a Starter owner sees the upgrade variant and routes to the Billing tab", async () => {
    mockEligibility({ ok: true, eligible: false, reason: "not_eligible" });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    expect(await screen.findByText("workspace.create.error_not_eligible_title")).toBeTruthy();
    // No name input — they never reach it.
    expect(screen.queryByLabelText(/dialog_name_label/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /error_not_eligible_cta/ }));
    expect(navigateMock).toHaveBeenCalledWith("/app/settings/account?tab=billing");
  });

  it("no card on file shows the billing variant and routes to the subscription tab", async () => {
    mockEligibility({ ok: true, eligible: false, reason: "no_card_on_file" });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    expect(await screen.findByText("workspace.create.error_no_card_title")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /error_no_card_cta/ }));
    expect(navigateMock).toHaveBeenCalledWith("/app/settings/account?tab=billing");
  });

  it("at the workspace cap shows the cap variant with count + cap params", async () => {
    mockEligibility({ ok: true, eligible: false, reason: "cap_reached", count: 10, cap: 10 });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    const title = await screen.findByText(/workspace.create.error_cap_reached_title/);
    expect(title).toBeTruthy();
    const body = screen.getByText(/workspace.create.error_cap_reached_body/);
    expect(body.textContent).toContain("count=10");
    expect(body.textContent).toContain("cap=10");
  });

  it("suppressed owners skip the gate and open at the name step (preview deferred to confirm)", async () => {
    localStorage.setItem(ACK_SUPPRESS_KEY, "1");
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    // Name step immediately; gate copy absent; no eligibility call yet.
    expect(screen.getByLabelText(/dialog_name_label/)).toBeTruthy();
    expect(screen.queryByText("workspace.create.acknowledge_title")).toBeNull();
    expect(
      invokeMock.mock.calls.filter(
        (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "preview",
      ).length,
    ).toBe(0);
  });

  it("resume mode bypasses the gate entirely", async () => {
    // Resume preview returns the existing-PI payload.
    mockEligibility({
      ok: true,
      eligible: true,
      cardLast4: "4242",
      cardBrand: "visa",
      priceMonthly: 499,
      chargedToday: 499,
      count: 1,
      cap: 10,
      resume: { workspaceId: "ws-9", name: "Resumed WS", clientSecret: "pi_secret_resume" },
    });
    await act(async () => {
      render(
        <NewWorkspaceDialog open={true} onOpenChange={() => {}} resumeWorkspaceId="ws-9" />,
      );
    });
    // Goes straight to the confirm panel — never shows the gate.
    expect(await screen.findByText(/workspace.create.confirm_title/)).toBeTruthy();
    expect(screen.queryByText("workspace.create.acknowledge_title")).toBeNull();
  });
});

describe("NewWorkspaceDialog — confirm button disabled during in-flight", () => {
  it("Confirm button shows loading state while confirm is in-flight", async () => {
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    await advanceToConfirmStep();

    // Make the confirm call hang so we can observe the in-flight state.
    let resolveInvoke: (value: unknown) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );

    const confirmBtn = screen.getByRole("button", { name: /confirm_button/ });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    // The button label flips to confirm_button_loading.
    expect(screen.getByRole("button", { name: /confirm_button_loading/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /confirm_button_loading/ }).hasAttribute("disabled"),
    ).toBe(true);
    // Cancel (ghost) button is also disabled in-flight.
    const cancelBtn = screen.getByRole("button", { name: /dialog_cancel/ });
    expect(cancelBtn.hasAttribute("disabled")).toBe(true);

    // Resolve cleanly so the test doesn't leak the promise.
    resolveInvoke!({
      data: { ok: false, reason: "stripe_error", error: "wrap-up" },
      error: null,
    });
  });
});

// New coverage for the price-awareness gate's edge behaviors that the original
// gate block didn't pin: the reopen-reset step derivation, the loading-frame
// neutral title, the renewalDayLabel ordinal/cardinal helper, and ackSuppressed
// failing open when localStorage throws.
describe("NewWorkspaceDialog — gate edge cases", () => {
  beforeEach(() => {
    // These tests exercise the un-suppressed gate; the module beforeEach set the
    // suppression flag for the legacy flow tests, so clear it here.
    localStorage.removeItem(ACK_SUPPRESS_KEY);
  });

  function mockEligibility(resp: Record<string, unknown>) {
    invokeMock.mockResolvedValueOnce({ data: resp, error: null });
  }

  // (a) Regression: a non-suppressed REOPEN must land on the gate, not the name
  // step. The reset effect derives the entry step from ackSuppressed() rather
  // than hardcoding "name" — if it regressed to a hardcoded "name", a reopened
  // dialog would silently skip the price gate.
  it("a non-suppressed reopen lands on the gate, not the name step", async () => {
    const onOpenChange = vi.fn();
    // Open #1 — eligible gate.
    mockEligibility({ ok: true, eligible: true, count: 1, cap: 10 });
    const { rerender } = render(
      <NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />,
    );
    await act(async () => {});
    await screen.findByText("workspace.create.acknowledge_title");

    // Close.
    rerender(<NewWorkspaceDialog open={false} onOpenChange={onOpenChange} />);

    // Reopen — must show the GATE again (acknowledge), NOT the name input.
    mockEligibility({ ok: true, eligible: true, count: 1, cap: 10 });
    await act(async () => {
      rerender(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);
    });
    expect(await screen.findByText("workspace.create.acknowledge_title")).toBeTruthy();
    // The name input must NOT be present on reopen — that's the regression guard.
    expect(screen.queryByLabelText(/dialog_name_label/)).toBeNull();
  });

  // (c) While eligibility is unknown (loading), the title must be the NEUTRAL
  // dialog_title — never acknowledge_title — so a user who turns out to be on
  // Starter doesn't briefly read "adds to your subscription".
  it("the loading frame shows the neutral dialog_title, not acknowledge_title", async () => {
    // Hold the eligibility call open so we can observe the loading frame.
    let resolveInvoke: (value: unknown) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });

    // Loading frame: neutral title + loading description, NOT the acknowledge title.
    expect(screen.getByText("workspace.create.dialog_title")).toBeTruthy();
    expect(screen.getByText("workspace.create.acknowledge_loading")).toBeTruthy();
    expect(screen.queryByText("workspace.create.acknowledge_title")).toBeNull();

    // Resolve as Starter — the loading title must NEVER have leaked acknowledge copy.
    await act(async () => {
      resolveInvoke!({
        data: { ok: true, eligible: false, reason: "not_eligible" },
        error: null,
      });
    });
    expect(await screen.findByText("workspace.create.error_not_eligible_title")).toBeTruthy();
    // The acknowledge_title was never shown at any point in this flow.
    expect(screen.queryByText("workspace.create.acknowledge_title")).toBeNull();
  });

  // (b) renewalDayLabel — English ordinal. The helper is module-private, so we
  // pin its contract end-to-end: the rendered recurring bullet threads the
  // computed day through the mock t() (which echoes params), and we control
  // "today" via fake timers. Covers the ordinal edge cases 1st/2nd/3rd/11th/
  // 21st/22nd plus a vanilla "th".
  const ordinalCases: Array<[string, string]> = [
    ["2026-06-01T12:00:00", "1st"],
    ["2026-06-02T12:00:00", "2nd"],
    ["2026-06-03T12:00:00", "3rd"],
    ["2026-06-04T12:00:00", "4th"],
    ["2026-06-11T12:00:00", "11th"],
    ["2026-06-12T12:00:00", "12th"],
    ["2026-06-13T12:00:00", "13th"],
    ["2026-06-21T12:00:00", "21st"],
    ["2026-06-22T12:00:00", "22nd"],
    ["2026-06-23T12:00:00", "23rd"],
  ];

  for (const [dateStr, expected] of ordinalCases) {
    it(`renders the English ordinal "${expected}" for ${dateStr.slice(0, 10)}`, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date(dateStr));
      mockEligibility({ ok: true, eligible: true, count: 1, cap: 10 });
      await act(async () => {
        render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
      });
      await screen.findByText("workspace.create.acknowledge_title");
      // The recurring bullet echoes `day=<ordinal>` via the mock t().
      const bullet = screen.getByText(/acknowledge_bullet_recurring/);
      expect(bullet.textContent).toContain(`day=${expected}`);
    });
  }

  it("renders the Spanish CARDINAL (no ordinal suffix) for the recurring day", async () => {
    langValue = "es";
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-21T12:00:00"));
    mockEligibility({ ok: true, eligible: true, count: 1, cap: 10 });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    await screen.findByText("workspace.create.acknowledge_title");
    const bullet = screen.getByText(/acknowledge_bullet_recurring/);
    // Spanish uses the bare cardinal "21" — NOT "21st".
    expect(bullet.textContent).toContain("day=21");
    expect(bullet.textContent).not.toContain("21st");
  });

  // (d) ackSuppressed() must fail OPEN: if localStorage.getItem throws (private
  // mode / blocked storage), the gate must STILL show — never skip silently to
  // the name step on the assumption the user suppressed it.
  it("fails open and shows the gate when localStorage.getItem throws", async () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage blocked");
      });
    try {
      mockEligibility({ ok: true, eligible: true, count: 1, cap: 10 });
      await act(async () => {
        render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
      });
      // Gate is shown (fail-open), and the eligibility call fired.
      expect(await screen.findByText("workspace.create.acknowledge_title")).toBeTruthy();
      expect(screen.queryByLabelText(/dialog_name_label/)).toBeNull();
      const previewCall = invokeMock.mock.calls.find(
        (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "preview",
      );
      expect(previewCall).toBeDefined();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  // (e) Eligibility-call FAILURE → the gate's error variant. This is the
  // never-strand guarantee: a transport-level invoke error must not leave the
  // user on a spinner. It must surface the stripe_unverified copy AND the
  // acknowledge_retry affordance (the gate's own retry, distinct from the
  // confirm-step error pane).
  it("an invokeError on the eligibility call shows the gate error variant with a retry button", async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: { message: "network down" } });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    expect(
      await screen.findByText("workspace.create.error_stripe_unverified_title"),
    ).toBeTruthy();
    // The gate's retry affordance is present; the user is not stranded.
    expect(screen.getByRole("button", { name: /acknowledge_retry/ })).toBeTruthy();
    // No name input — they never advanced past the gate.
    expect(screen.queryByLabelText(/dialog_name_label/)).toBeNull();
  });

  // resp.ok === false (server returned a non-OK body, not a transport error)
  // must also land on the error variant — the eligibility branch checks ok
  // separately from invokeError, so this is a distinct code path.
  it("a non-ok eligibility response body shows the gate error variant", async () => {
    mockEligibility({ ok: false });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    expect(
      await screen.findByText("workspace.create.error_stripe_unverified_title"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /acknowledge_retry/ })).toBeTruthy();
  });

  // The retry button must actually RE-FIRE the eligibility call and recover —
  // error → retry → ready → Continue → name. If the retry stopped re-invoking
  // or stopped resetting ackState, a transient failure would become permanent.
  it("the gate retry button re-fires eligibility and recovers to the ready gate", async () => {
    // First eligibility call fails.
    invokeMock.mockResolvedValueOnce({ data: null, error: { message: "blip" } });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    await screen.findByText("workspace.create.error_stripe_unverified_title");

    // Second eligibility call (the retry) succeeds.
    mockEligibility({ ok: true, eligible: true, count: 1, cap: 10 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /acknowledge_retry/ }));
    });

    // Recovered: the ready gate renders and the error copy is gone.
    expect(await screen.findByText("workspace.create.acknowledge_title")).toBeTruthy();
    expect(
      screen.queryByText("workspace.create.error_stripe_unverified_title"),
    ).toBeNull();
    // Exactly two eligibility (preview) calls fired: the initial + the retry.
    expect(
      invokeMock.mock.calls.filter(
        (c) => (c[1] as { body?: { mode?: string } })?.body?.mode === "preview",
      ).length,
    ).toBe(2);
  });

  // no_customer at the GATE maps to the no_card variant (route to billing).
  // The existing error-branch suite covers no_customer only at the confirm/
  // preview ErrorPane; the gate's switch is a separate mapping.
  it("no_customer at the gate shows the no_card billing variant and routes to the subscription tab", async () => {
    mockEligibility({ ok: true, eligible: false, reason: "no_customer" });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    expect(await screen.findByText("workspace.create.error_no_card_title")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /error_no_card_cta/ }));
    expect(navigateMock).toHaveBeenCalledWith("/app/settings/account?tab=billing");
  });

  // An unrecognized not-eligible reason falls through the gate switch's default
  // to the error variant — never a blank panel, never a silent advance.
  it("an unknown not-eligible reason falls back to the gate error variant", async () => {
    mockEligibility({ ok: true, eligible: false, reason: "something_unexpected" });
    await act(async () => {
      render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    });
    expect(
      await screen.findByText("workspace.create.error_stripe_unverified_title"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /acknowledge_retry/ })).toBeTruthy();
  });
});
