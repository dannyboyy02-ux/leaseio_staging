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
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Workspace Management Phase 3 (spec §4.2) — TransferOwnershipDialog.
//
// What we pin:
//   1. Empty state: when no accepted member (other than the owner) exists,
//      the "No eligible members yet" guidance renders and the Transfer
//      confirm button is NOT rendered at all.
//   2. Two-key confirm gate: the Transfer button stays disabled until BOTH a
//      target is selected AND the billing-acknowledgment checkbox is checked.
//   3. On confirm, the dialog invokes the edge function with EXACTLY
//      { body: { workspaceId, targetUserId } } and, on ok=true, closes the
//      dialog + fires onTransferred (caller refetches AppContext).
//
// Radix Select isn't interactable under jsdom (pointer-event driven), so we
// mock @/components/ui/select with a native <select> — the contract under
// test is the dialog's gating + invoke payload, not Radix internals.

// --- Mocks ----------------------------------------------------------------

const invokeMock = vi.fn();
const fromMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

// Key-passthrough, mirroring the NewWorkspaceDialog test convention — the
// dialog renders workspace.transfer.* keys so assertions pin keys, not copy.
vi.mock("@/hooks/useAppTranslation", () => ({
  useAppTranslation: () => ({
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

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      data-testid="transfer-target-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      <option value="" hidden />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { TransferOwnershipDialog } from "../TransferOwnershipDialog";

// --- Helpers --------------------------------------------------------------

/** PostgREST-ish chainable builder that is itself thenable. */
function thenableBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "not", "in", "order", "limit"]) {
    builder[m] = vi.fn(() => builder);
  }
  (builder as { then: unknown }).then = (
    res: (v: unknown) => unknown,
    rej?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(res, rej);
  return builder;
}

function setMembers(
  members: Array<{ user_id: string; accepted_at: string }>,
  profiles: Array<{ id: string; email: string; first_name?: string; last_name?: string }>,
) {
  fromMock.mockImplementation((table: string) => {
    if (table === "workspace_members") {
      return thenableBuilder({ data: members, error: null });
    }
    if (table === "profiles") {
      return thenableBuilder({ data: profiles, error: null });
    }
    throw new Error(`unexpected table: ${table}`);
  });
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof TransferOwnershipDialog>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    workspaceId: "11111111-1111-4111-8111-111111111111",
    workspaceName: "Acme Finance",
    ownerId: "owner-1",
    onTransferred: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <TransferOwnershipDialog {...props} />
    </QueryClientProvider>,
  );
  return props;
}

beforeEach(() => {
  invokeMock.mockReset();
  fromMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  cleanup();
});

// --- Tests ----------------------------------------------------------------

describe("TransferOwnershipDialog — empty state", () => {
  it("shows the no-eligible-members guidance and no Transfer button when the member list is empty", async () => {
    setMembers([], []);
    renderDialog();

    expect(await screen.findByText("workspace.transfer.empty_title")).toBeTruthy();
    // The footer confirm button is conditionally rendered only when eligible
    // members exist — Cancel remains, Transfer must be absent.
    expect(
      screen.queryByRole("button", { name: "workspace.transfer.confirm" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "workspace.transfer.cancel" }),
    ).toBeTruthy();
  });

  it("offers the Manage members escape hatch: closes the dialog and fires onManageMembers", async () => {
    setMembers([], []);
    const onManageMembers = vi.fn();
    const props = renderDialog({ onManageMembers });

    fireEvent.click(
      await screen.findByRole("button", { name: "workspace.transfer.empty_cta" }),
    );
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(onManageMembers).toHaveBeenCalledTimes(1);
  });
});

describe("TransferOwnershipDialog — fetch error state", () => {
  it("renders the error pane with a retry action — NOT the empty state — when the members query fails", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "workspace_members") {
        return thenableBuilder({ data: null, error: new Error("boom") });
      }
      throw new Error(`unexpected table: ${table}`);
    });
    renderDialog();

    expect(await screen.findByText("workspace.transfer.error_title")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "workspace.transfer.retry" }),
    ).toBeTruthy();
    // A transient fetch error must not tell the owner they have no members.
    expect(screen.queryByText("workspace.transfer.empty_title")).toBeNull();
    // And no confirm button either.
    expect(
      screen.queryByRole("button", { name: "workspace.transfer.confirm" }),
    ).toBeNull();
  });
});

describe("TransferOwnershipDialog — confirm gating", () => {
  const member = { user_id: "u2", accepted_at: "2026-06-01T00:00:00Z" };
  const profile = {
    id: "u2",
    email: "bea@acme.com",
    first_name: "Bea",
    last_name: "Nguyen",
  };

  it("Transfer stays disabled until BOTH a target is selected AND the acknowledgment is checked", async () => {
    setMembers([member], [profile]);
    renderDialog();

    const transferBtn = await screen.findByRole("button", {
      name: "workspace.transfer.confirm",
    });
    // Nothing selected, nothing acknowledged.
    expect(transferBtn.hasAttribute("disabled")).toBe(true);

    // Acknowledgment alone is not enough.
    fireEvent.click(screen.getByRole("checkbox"));
    expect(transferBtn.hasAttribute("disabled")).toBe(true);

    // Target alone (uncheck first) is not enough either.
    fireEvent.click(screen.getByRole("checkbox")); // uncheck
    fireEvent.change(screen.getByTestId("transfer-target-select"), {
      target: { value: "u2" },
    });
    expect(transferBtn.hasAttribute("disabled")).toBe(true);

    // Both → enabled.
    fireEvent.click(screen.getByRole("checkbox"));
    expect(transferBtn.hasAttribute("disabled")).toBe(false);
  });

  it("on confirm, invokes transfer-workspace-ownership with { workspaceId, targetUserId } and closes on ok=true", async () => {
    setMembers([member], [profile]);
    invokeMock.mockResolvedValueOnce({ data: { ok: true }, error: null });
    const props = renderDialog();

    await screen.findByRole("button", { name: "workspace.transfer.confirm" });
    fireEvent.change(screen.getByTestId("transfer-target-select"), {
      target: { value: "u2" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "workspace.transfer.confirm" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("transfer-workspace-ownership", {
        body: { workspaceId: props.workspaceId, targetUserId: "u2" },
      });
    });
    await waitFor(() => {
      expect(props.onTransferred).toHaveBeenCalledTimes(1);
    });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("on ok=false, surfaces the server error and does NOT close or fire onTransferred", async () => {
    setMembers([member], [profile]);
    invokeMock.mockResolvedValueOnce({
      data: { ok: false, error: "Target must be a member of this workspace who has accepted their invite" },
      error: null,
    });
    const props = renderDialog();

    await screen.findByRole("button", { name: "workspace.transfer.confirm" });
    fireEvent.change(screen.getByTestId("transfer-target-select"), {
      target: { value: "u2" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "workspace.transfer.confirm" }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Target must be a member of this workspace who has accepted their invite",
      );
    });
    expect(props.onTransferred).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
