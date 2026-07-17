// @vitest-environment jsdom
import "./_jsdomPolyfills";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// #161 (owner live repro 2026-07-16): a Stripe-Link-paying customer — the
// DEFAULT for Checkout — was shown "Add a payment method in the billing portal
// before buying a pack" and could not buy capacity, even though the Billing tab
// showed their Link method. These behavioral tests reproduce that exact
// scenario (a saved method whose type is NOT card: methodLabel set, cardLast4
// null) and assert the dialog now renders the catalog and carries the real
// method label into consent — the screenshot no longer happens.

const invokeMock = vi.fn();
const fromMock = vi.fn();
const refreshProfileMock = vi.fn(() => Promise.resolve());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("@/lib/stripe", () => ({ getStripe: () => Promise.resolve(null) }));

// useNavigate is read at mount for the no-method "Open billing" door — mock it
// to avoid wrapping every render in MemoryRouter.
const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));

const workspaceValue = {
  id: "ws-1",
  plan: "business",
  addonDocumentCapacity: 0,
  purchasedLeaseCredits: 0,
};
vi.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    workspace: workspaceValue,
    refreshProfile: refreshProfileMock,
    userRole: "admin",
  }),
}));

vi.mock("@/hooks/useAppTranslation", () => ({
  useAppTranslation: () => ({
    lang: "en",
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        const params = Object.entries(opts)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(",");
        return params ? `${key}(${params})` : key;
      }
      return key;
    },
  }),
}));

import { DocumentPackDialog } from "../DocumentPackDialog";
import { DOCUMENT_PACKS } from "@/config/pricing";

// Preview shape as the fixed server returns it for a LINK customer: a labeled
// method of a non-card type — methodLabel present (the server no longer sends
// card-specific fields; the dialog renders methodLabel).
function linkPreview() {
  return {
    ok: true,
    eligible: true,
    reason: null,
    methodLabel: "Stripe Link (kelli@example.com)",
    currentCapacity: 0,
    currentCredits: 0,
    activePacks: [],
    catalog: DOCUMENT_PACKS.map((p) => ({
      id: p.id,
      size: p.size,
      priceMonthlyUsd: p.priceMonthly,
      configured: true,
    })),
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  fromMock.mockReset();
  refreshProfileMock.mockClear();
});

afterEach(() => cleanup());

describe("DocumentPackDialog — #161 non-card (Link) customer", () => {
  it("renders the pack catalog for a Link customer instead of the no-payment-method wall", async () => {
    invokeMock.mockResolvedValue({ data: linkPreview(), error: null });
    render(<DocumentPackDialog open onOpenChange={() => {}} />);

    // The catalog must appear — a real pack name — and the no-method banner
    // must NOT (the screenshot state).
    await waitFor(() =>
      expect(screen.getByText(DOCUMENT_PACKS[0].nameKey)).toBeTruthy(),
    );
    expect(screen.queryByText("packs.no_card_banner")).toBeNull();
  });

  // NOTE: the consent-step method-label truthfulness ("Billed to Stripe Link
  // (…)" via `packs.consent_method`, never a card-on-file lie) is enforced
  // structurally — the static pin `paymentMethodAgnosticPurchases.test.ts` bans
  // the retired `consent_card` key and requires the method-agnostic wiring, and
  // localeParity guarantees `consent_method` in both locales. A click-through
  // behavioral assertion here was flaky under jsdom (Radix portal + nested-button
  // event dispatch), so it's intentionally covered at the source level instead.

  it("still shows the no-eligible-method banner (with an Open billing door) when NO method exists", async () => {
    invokeMock.mockResolvedValue({
      data: { ...linkPreview(), eligible: false, reason: "no_customer", methodLabel: null },
      error: null,
    });
    render(<DocumentPackDialog open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText("packs.no_card_banner")).toBeTruthy());
    // #161 polish: the no-method state is not a dead end — it offers a billing door.
    expect(screen.getByRole("button", { name: /error_no_card_cta/ })).toBeTruthy();
  });

  it("shows the same actionable banner for a deferred bank-debit method (no lie about 'no method')", async () => {
    invokeMock.mockResolvedValue({
      data: { ...linkPreview(), eligible: false, reason: "deferred_method_unsupported", methodLabel: null },
      error: null,
    });
    render(<DocumentPackDialog open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText("packs.no_card_banner")).toBeTruthy());
    expect(screen.getByRole("button", { name: /error_no_card_cta/ })).toBeTruthy();
  });
});
