// @vitest-environment jsdom
import "./_jsdomPolyfills";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.1 (switcher behavior) + §P2.11.
//
// What we pin:
//   - Recent ordering: when total workspaces >= RECENT_THRESHOLD (5), the
//     palette surfaces the last-3 recent IDs above the alpha list. Below 5,
//     recents are suppressed (noise).
//   - Alpha ordering: non-active, non-recent workspaces appear sorted by name.
//   - The active workspace is rendered as the current-marker, not in alpha.
//   - "+ New workspace" entry shows only when canCreate is true.
//   - Esc / setting open=false closes (CommandDialog uses Radix; tested by
//     toggling the open prop and checking the input disappears).
//   - pushRecentWorkspace pushes newest-first, dedupes, caps at 3.
//   - clearRecentWorkspaces empties the list.

// --- Mocks ----------------------------------------------------------------

const switchWorkspaceMock = vi.fn();
const useAppMock = vi.fn();

vi.mock("@/contexts/AppContext", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("@/hooks/useAppTranslation", () => ({
  useAppTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts && (opts as { defaultValue?: string }).defaultValue) || key,
  }),
}));

import {
  WorkspaceCommandPalette,
  pushRecentWorkspace,
  clearRecentWorkspaces,
} from "../WorkspaceCommandPalette";

interface MockWs {
  id: string;
  name: string;
  plan: string;
  subscription_status: string | null;
  role: string;
}

function setApp(workspaces: MockWs[], activeId: string | null = null) {
  useAppMock.mockReturnValue({
    workspace: workspaces.find((w) => w.id === activeId) ?? null,
    availableWorkspaces: workspaces,
    switchWorkspace: switchWorkspaceMock,
  });
}

beforeEach(() => {
  switchWorkspaceMock.mockReset();
  useAppMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceCommandPalette — ordering + create entry", () => {
  it("renders alpha ordering for non-active workspaces (≤5 — recents suppressed)", () => {
    const wss: MockWs[] = [
      { id: "a", name: "Alpha", plan: "business", subscription_status: "active", role: "owner" },
      { id: "z", name: "Zulu",  plan: "business", subscription_status: "active", role: "owner" },
      { id: "m", name: "Mango", plan: "business", subscription_status: "active", role: "owner" },
    ];
    setApp(wss, "a");
    render(
      <WorkspaceCommandPalette
        open={true}
        onOpenChange={() => {}}
        canCreate={true}
        onCreate={() => {}}
      />,
    );

    // The alpha section excludes the active workspace ("Alpha"), so it should
    // render "Mango" before "Zulu". Find headings then walk the rendered DOM.
    const allItems = screen.getAllByRole("option");
    // The "current" disabled marker + alpha entries + the create entry.
    const labels = allItems.map((el) => el.textContent ?? "");
    // Active workspace is rendered with an active marker.
    expect(labels.find((l) => l.includes("Alpha"))).toBeDefined();
    // Mango should come BEFORE Zulu in the rendered output.
    const idxMango = labels.findIndex((l) => l.includes("Mango"));
    const idxZulu = labels.findIndex((l) => l.includes("Zulu"));
    expect(idxMango).toBeGreaterThan(-1);
    expect(idxZulu).toBeGreaterThan(idxMango);
  });

  it("surfaces recent workspaces above alpha when total >= 5", () => {
    const wss: MockWs[] = Array.from({ length: 6 }, (_, i) => ({
      id: `id-${i}`,
      name: `Workspace ${String.fromCharCode(70 - i)}`, // F, E, D, C, B, A
      plan: "business",
      subscription_status: "active",
      role: "owner",
    }));
    setApp(wss, "id-0");
    localStorage.setItem("lease:recentWorkspaces", JSON.stringify(["id-3", "id-5"]));

    render(
      <WorkspaceCommandPalette
        open={true}
        onOpenChange={() => {}}
        canCreate={true}
        onCreate={() => {}}
      />,
    );
    const items = screen.getAllByRole("option");
    const labels = items.map((el) => el.textContent ?? "");
    // The recent list should put id-3 + id-5 ahead of any alpha-only entry.
    const idxRecent3 = labels.findIndex((l) => l.includes("Workspace C")); // id-3 -> char 70-3=67 'C'
    const idxRecent5 = labels.findIndex((l) => l.includes("Workspace A")); // id-5 -> 'A'
    expect(idxRecent3).toBeGreaterThan(-1);
    expect(idxRecent5).toBeGreaterThan(-1);
    // And a non-recent workspace ('B' = id-4) should appear AFTER both recents.
    const idxAlphaB = labels.findIndex((l) => l.includes("Workspace B"));
    expect(idxAlphaB).toBeGreaterThan(idxRecent3);
    expect(idxAlphaB).toBeGreaterThan(idxRecent5);
  });

  it("does NOT show recents section when total < 5 (suppressed as noise)", () => {
    const wss: MockWs[] = Array.from({ length: 3 }, (_, i) => ({
      id: `id-${i}`,
      name: `Ws${i}`,
      plan: "business",
      subscription_status: "active",
      role: "owner",
    }));
    setApp(wss, "id-0");
    localStorage.setItem("lease:recentWorkspaces", JSON.stringify(["id-1"]));

    render(
      <WorkspaceCommandPalette
        open={true}
        onOpenChange={() => {}}
        canCreate={false}
        onCreate={() => {}}
      />,
    );
    // No "Recent" heading group when total is below the threshold.
    expect(screen.queryByText("Recent")).toBeNull();
  });

  it("shows '+ New workspace' entry when canCreate=true; omits it when false", () => {
    const wss: MockWs[] = [
      { id: "a", name: "Alpha", plan: "business", subscription_status: "active", role: "owner" },
    ];
    setApp(wss, "a");

    const { rerender } = render(
      <WorkspaceCommandPalette
        open={true}
        onOpenChange={() => {}}
        canCreate={true}
        onCreate={() => {}}
      />,
    );
    expect(screen.queryByText("workspace.create.cta_palette")).not.toBeNull();

    rerender(
      <WorkspaceCommandPalette
        open={true}
        onOpenChange={() => {}}
        canCreate={false}
        onCreate={() => {}}
      />,
    );
    expect(screen.queryByText("workspace.create.cta_palette")).toBeNull();
  });

  it("clicking a workspace calls switchWorkspace and closes the palette", () => {
    const wss: MockWs[] = [
      { id: "a", name: "Alpha", plan: "business", subscription_status: "active", role: "owner" },
      { id: "b", name: "Bravo", plan: "business", subscription_status: "active", role: "owner" },
    ];
    setApp(wss, "a");
    const onOpenChange = vi.fn();

    render(
      <WorkspaceCommandPalette
        open={true}
        onOpenChange={onOpenChange}
        canCreate={false}
        onCreate={() => {}}
      />,
    );

    // Click the Bravo entry.
    const bravo = screen.getByText("Bravo");
    fireEvent.click(bravo);
    expect(switchWorkspaceMock).toHaveBeenCalledWith("b");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closing the palette via open=false stops rendering the input", () => {
    const wss: MockWs[] = [
      { id: "a", name: "Alpha", plan: "business", subscription_status: "active", role: "owner" },
    ];
    setApp(wss, "a");

    const { rerender } = render(
      <WorkspaceCommandPalette
        open={true}
        onOpenChange={() => {}}
        canCreate={false}
        onCreate={() => {}}
      />,
    );
    expect(screen.getByPlaceholderText("workspace.create.search_placeholder")).not.toBeNull();

    rerender(
      <WorkspaceCommandPalette
        open={false}
        onOpenChange={() => {}}
        canCreate={false}
        onCreate={() => {}}
      />,
    );
    expect(screen.queryByPlaceholderText("workspace.create.search_placeholder")).toBeNull();
  });
});

describe("recent-workspaces persistence helpers", () => {
  it("pushRecentWorkspace stores newest-first, dedupes, caps at 3", () => {
    pushRecentWorkspace("a");
    pushRecentWorkspace("b");
    pushRecentWorkspace("c");
    pushRecentWorkspace("d"); // pushes 'a' off the back
    const raw = localStorage.getItem("lease:recentWorkspaces");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(["d", "c", "b"]);

    // Re-pushing an existing id moves it to the front; doesn't grow the list.
    pushRecentWorkspace("b");
    expect(JSON.parse(localStorage.getItem("lease:recentWorkspaces")!)).toEqual([
      "b",
      "d",
      "c",
    ]);
  });

  it("clearRecentWorkspaces removes the key (logout hook target)", () => {
    pushRecentWorkspace("a");
    expect(localStorage.getItem("lease:recentWorkspaces")).not.toBeNull();
    clearRecentWorkspaces();
    expect(localStorage.getItem("lease:recentWorkspaces")).toBeNull();
  });

  it("pushRecentWorkspace tolerates a broken JSON value", () => {
    localStorage.setItem("lease:recentWorkspaces", "{not json");
    expect(() => pushRecentWorkspace("a")).not.toThrow();
    expect(JSON.parse(localStorage.getItem("lease:recentWorkspaces")!)).toEqual(["a"]);
  });
});
