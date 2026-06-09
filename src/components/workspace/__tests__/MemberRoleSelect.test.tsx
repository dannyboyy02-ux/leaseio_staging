// @vitest-environment jsdom
import "./_jsdomPolyfills";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// Regression coverage for the Phase 4 fix pass: a role change must write a
// workspace_activity_log row with event_type 'member_role_changed' — NOT the
// phantom 'member_added' it briefly logged (Phase 4 review finding). An audit
// trail that mislabels role changes as new members silently corrupts the
// member-history story.
//
// Also pinned:
//   - The role UPDATE targets the member row by id.
//   - The audit insert is fire-and-forget: an audit-write failure must not
//     surface as a role-change failure (the role update already committed).
//   - No audit write is attempted when workspaceId/targetUserId are absent
//     (legacy call sites without the audit context).
//
// Radix Select isn't interactable under jsdom, so we mock the ui/select
// module with a native <select> — the contract under test is the component's
// update + audit logic, not Radix internals.

// --- Mocks ----------------------------------------------------------------

const fromMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
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

// --- Helpers --------------------------------------------------------------

const updateMock = vi.fn();
const updateEqMock = vi.fn();
const insertMock = vi.fn();

function wireSupabase({
  updateError = null,
  auditError = null,
}: { updateError?: unknown; auditError?: unknown } = {}) {
  updateEqMock.mockImplementation(() => Promise.resolve({ error: updateError }));
  updateMock.mockImplementation(() => ({ eq: updateEqMock }));
  insertMock.mockImplementation(() => Promise.resolve({ error: auditError }));
  fromMock.mockImplementation((table: string) => {
    if (table === "workspace_members") return { update: updateMock };
    if (table === "workspace_activity_log") return { insert: insertMock };
    throw new Error(`unexpected table: ${table}`);
  });
}

beforeEach(() => {
  fromMock.mockReset();
  updateMock.mockReset();
  updateEqMock.mockReset();
  insertMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  wireSupabase();
});

afterEach(() => {
  cleanup();
});

// --- Tests ----------------------------------------------------------------

describe("MemberRoleSelect — audit-trail correctness", () => {
  it("logs event_type 'member_role_changed' (NOT 'member_added') with target, new role, and previous role", async () => {
    const onRoleChanged = vi.fn();
    render(
      <MemberRoleSelect
        memberId="member-1"
        currentRole="viewer"
        onRoleChanged={onRoleChanged}
        workspaceId="ws-1"
        targetUserId="u2"
      />,
    );

    fireEvent.change(screen.getByTestId("role-select"), {
      target: { value: "editor" },
    });

    await waitFor(() => expect(insertMock).toHaveBeenCalledTimes(1));
    const payload = insertMock.mock.calls[0][0] as {
      workspace_id: string;
      event_type: string;
      details: Record<string, unknown>;
    };
    expect(payload.event_type).toBe("member_role_changed");
    expect(payload.workspace_id).toBe("ws-1");
    expect(payload.details).toEqual({
      target_user_id: "u2",
      role: "editor",
      previous_role: "viewer",
    });

    // The phantom event_type must never come back.
    const eventTypes = insertMock.mock.calls.map(
      (c) => (c[0] as { event_type: string }).event_type,
    );
    expect(eventTypes).not.toContain("member_added");

    // The role UPDATE itself targeted the member row by id.
    expect(updateMock).toHaveBeenCalledWith({ role: "editor" });
    expect(updateEqMock).toHaveBeenCalledWith("id", "member-1");
    expect(onRoleChanged).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("skips the audit write when workspaceId/targetUserId are not provided (no malformed rows)", async () => {
    render(
      <MemberRoleSelect
        memberId="member-1"
        currentRole="viewer"
        onRoleChanged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId("role-select"), {
      target: { value: "admin" },
    });

    await waitFor(() => expect(updateEqMock).toHaveBeenCalled());
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("an audit-write failure does NOT surface as a role-change failure (fire-and-forget)", async () => {
    wireSupabase({ auditError: { message: "rls denied" } });
    const onRoleChanged = vi.fn();
    render(
      <MemberRoleSelect
        memberId="member-1"
        currentRole="editor"
        onRoleChanged={onRoleChanged}
        workspaceId="ws-1"
        targetUserId="u2"
      />,
    );

    fireEvent.change(screen.getByTestId("role-select"), {
      target: { value: "viewer" },
    });

    await waitFor(() => expect(insertMock).toHaveBeenCalled());
    // Role change still reported as success; no error toast.
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(onRoleChanged).toHaveBeenCalledTimes(1);
  });

  it("a failed role UPDATE shows the error toast and writes NO audit row", async () => {
    wireSupabase({ updateError: { message: "permission denied" } });
    const onRoleChanged = vi.fn();
    render(
      <MemberRoleSelect
        memberId="member-1"
        currentRole="viewer"
        onRoleChanged={onRoleChanged}
        workspaceId="ws-1"
        targetUserId="u2"
      />,
    );

    fireEvent.change(screen.getByTestId("role-select"), {
      target: { value: "editor" },
    });

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(insertMock).not.toHaveBeenCalled();
    expect(onRoleChanged).not.toHaveBeenCalled();
  });
});
