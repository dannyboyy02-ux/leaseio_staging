// @vitest-environment jsdom
import "./_jsdomPolyfills";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Regression coverage for the fresh-eyes member-management fix: a role change
// now routes through the service-role `manage-workspace-member` edge function
// (owner-OR-admin authorization + server-side audit), because workspace_members
// UPDATE is owner-only at RLS — the old direct client UPDATE silently failed for
// admins. The audit write moved server-side, so the client no longer inserts.
//
// Pinned:
//   - A role change invokes manage-workspace-member with action 'set_role'.
//   - ok:true → success toast + onRoleChanged.
//   - reason 'not_authorized' / 'subscription_inactive' → the mapped toast.
//   - A transport error → generic failure toast, onRoleChanged NOT called.
//   - No direct workspace_members UPDATE is issued from the client.
//
// Radix Select isn't interactable under jsdom, so we mock ui/select with a
// native <select>.

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

vi.mock("@/hooks/useAppTranslation", () => ({
  useAppTranslation: () => ({ t: (k: string) => k }),
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
      data-testid="role-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
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

import { MemberRoleSelect } from "../MemberRoleSelect";

beforeEach(() => {
  invokeMock.mockReset();
  fromMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
});

afterEach(() => cleanup());

describe("MemberRoleSelect — routes role changes through the service-role fn", () => {
  it("invokes manage-workspace-member with action set_role and reports success", async () => {
    const onRoleChanged = vi.fn();
    render(
      <MemberRoleSelect
        memberId="member-1"
        currentRole="viewer"
        onRoleChanged={onRoleChanged}
        workspaceId="ws-1"
      />,
    );

    fireEvent.change(screen.getByTestId("role-select"), { target: { value: "editor" } });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("manage-workspace-member", {
      body: { action: "set_role", workspaceId: "ws-1", memberId: "member-1", role: "editor" },
    });
    // The client must NOT issue a direct workspace_members write (RLS owner-only).
    expect(fromMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(onRoleChanged).toHaveBeenCalledTimes(1);
  });

  it("errors without invoking when workspaceId is absent", async () => {
    render(<MemberRoleSelect memberId="member-1" currentRole="viewer" onRoleChanged={vi.fn()} />);
    fireEvent.change(screen.getByTestId("role-select"), { target: { value: "admin" } });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("maps reason 'not_authorized' to the forbidden toast", async () => {
    invokeMock.mockResolvedValue({ data: { ok: false, reason: "not_authorized" }, error: null });
    const onRoleChanged = vi.fn();
    render(
      <MemberRoleSelect memberId="m1" currentRole="viewer" onRoleChanged={onRoleChanged} workspaceId="ws-1" />,
    );
    fireEvent.change(screen.getByTestId("role-select"), { target: { value: "editor" } });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("workspace.members_panel.manage_forbidden"));
    expect(onRoleChanged).not.toHaveBeenCalled();
  });

  it("maps reason 'subscription_inactive' to the read-only toast", async () => {
    invokeMock.mockResolvedValue({ data: { ok: false, reason: "subscription_inactive" }, error: null });
    render(<MemberRoleSelect memberId="m1" currentRole="viewer" onRoleChanged={vi.fn()} workspaceId="ws-1" />);
    fireEvent.change(screen.getByTestId("role-select"), { target: { value: "editor" } });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("workspace.members_panel.role_readonly"));
  });

  it("a transport error shows the generic failure toast and does not report success", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "network" } });
    const onRoleChanged = vi.fn();
    render(
      <MemberRoleSelect memberId="m1" currentRole="viewer" onRoleChanged={onRoleChanged} workspaceId="ws-1" />,
    );
    fireEvent.change(screen.getByTestId("role-select"), { target: { value: "editor" } });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("workspace.members_panel.role_update_failed"));
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(onRoleChanged).not.toHaveBeenCalled();
  });
});
