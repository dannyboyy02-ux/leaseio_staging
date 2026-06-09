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
//   4. 3DS requires_action -> confirmCardPayment success -> activating ->
//      activated (poll observes Business+active).
//   5. confirmCardPayment ERROR -> cancel mode called (when PI is genuinely
//      not succeeded) -> error branch.
//
// We mock supabase, @stripe/stripe-js, getStripe, useApp, useAppTranslation.

// --- Mocks ----------------------------------------------------------------

const invokeMock = vi.fn();
const fromMock = vi.fn();
const switchWorkspaceMock = vi.fn();
const confirmCardPaymentMock = vi.fn();
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
  isStripeAvailable: () => true,
}));

vi.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    switchWorkspace: switchWorkspaceMock,
    availableWorkspaces: [],
    workspace: null,
  }),
}));

vi.mock("@/hooks/useAppTranslation", () => ({
  useAppTranslation: () => ({
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

import { NewWorkspaceDialog } from "../NewWorkspaceDialog";

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
    confirmCardPayment: confirmCardPaymentMock,
    retrievePaymentIntent: retrievePaymentIntentMock,
  };
  getStripeMock.mockReturnValue(Promise.resolve(stripeInstance));
  return stripeInstance;
}

beforeEach(() => {
  invokeMock.mockReset();
  fromMock.mockReset();
  switchWorkspaceMock.mockReset();
  confirmCardPaymentMock.mockReset();
  retrievePaymentIntentMock.mockReset();
  getStripeMock.mockReset();
  setupStripeMock();
  // Default: workspaces table read returns an active Business row (poll succeeds).
  fromMock.mockImplementation(() =>
    buildFromBuilder({ id: "ws-1", plan: "business", subscription_status: "active" }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  it("requires_action -> confirmCardPayment success -> Activating -> Activated", async () => {
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
    confirmCardPaymentMock.mockResolvedValueOnce({
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

    // confirmCardPayment was called with the clientSecret.
    expect(confirmCardPaymentMock).toHaveBeenCalledWith("pi_secret_xyz");

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

    // confirmCardPayment should NOT have been called.
    expect(confirmCardPaymentMock).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.queryByText(/workspace.create.activated_title/)).not.toBeNull(),
    );
  });
});

describe("NewWorkspaceDialog — 3DS error -> retrievePaymentIntent guard -> cancel", () => {
  it("on confirmCardPayment error AND PI is NOT succeeded, calls cancel mode", async () => {
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
    confirmCardPaymentMock.mockResolvedValueOnce({
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

  it("on confirmCardPayment error BUT PI is succeeded (network blip after success), does NOT cancel", async () => {
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
    confirmCardPaymentMock.mockResolvedValueOnce({
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
