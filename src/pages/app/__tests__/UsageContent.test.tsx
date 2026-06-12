// @vitest-environment jsdom
import "../../../components/workspace/__tests__/_jsdomPolyfills";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// Phase 4 fix pass — Starter usage card. A single-workspace plan always sits
// at 1/1 owned workspaces; that's the plan's NORMAL state, not an approaching
// limit. Before the fix, the workspaces card rendered a 100% (red) meter and
// the 1/1 ratio tripped the "approaching limit" upgrade banner on every
// Starter account. What we pin:
//   1. maxWorkspaces === 1 (Starter): the workspaces card shows the upgrade
//      hint, renders NO progress meter, and the 1/1 ratio alone does NOT
//      trigger the approaching-limit banner.
//   2. maxWorkspaces > 1 (Business): the meter renders.
//   3. The workspace ratio still participates in the banner on
//      multi-workspace plans (8/10 owned >= 75% -> banner shows).

// --- Mocks ----------------------------------------------------------------

const useAppMock = vi.fn();
vi.mock("@/contexts/AppContext", () => ({
  useApp: () => useAppMock(),
}));

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

// UsageContent renders <Link> for the upgrade CTAs; mock to a plain anchor so
// we don't need a router.
vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"} {...rest}>
      {children}
    </a>
  ),
}));

// Recent-archives query — return an empty list; not under test here.
const fromMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { UsageContent } from "../UsageContent";

// --- Helpers --------------------------------------------------------------

function emptyLeasesBuilder() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    builder[m] = vi.fn(() => builder);
  }
  (builder as { then: unknown }).then = (
    res: (v: unknown) => unknown,
    rej?: (e: unknown) => unknown,
  ) => Promise.resolve({ data: [], error: null }).then(res, rej);
  return builder;
}

interface SetAppArgs {
  plan: "starter" | "business";
  ownedWorkspaces: number;
  activeUsed?: number;
  activeMax?: number;
  archivedUsed?: number;
  archivedMax?: number;
}

function setApp({
  plan,
  ownedWorkspaces,
  activeUsed = 3,
  activeMax = 15,
  archivedUsed = 2,
  archivedMax = 50,
}: SetAppArgs) {
  useAppMock.mockReturnValue({
    workspace: {
      id: "ws-1",
      plan,
      activeLeasesUsed: activeUsed,
      maxActiveLeases: activeMax,
      archivedLeasesUsed: archivedUsed,
      maxArchivedLeases: archivedMax,
    },
    availableWorkspaces: Array.from({ length: ownedWorkspaces }, (_, i) => ({
      id: `ws-${i + 1}`,
      role: "owner",
    })),
  });
}

beforeEach(() => {
  useAppMock.mockReset();
  fromMock.mockReset();
  fromMock.mockImplementation(() => emptyLeasesBuilder());
});

afterEach(() => {
  cleanup();
});

// --- Tests ----------------------------------------------------------------

describe("UsageContent — workspaces card on a single-workspace plan (Starter)", () => {
  it("renders the upgrade hint and NO workspace progress meter at the normal 1/1 state", async () => {
    setApp({ plan: "starter", ownedWorkspaces: 1 });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getByText(/usage\.workspaces_upgrade_hint/)).toBeTruthy(),
    );

    // Only the active + archived meters render — NOT a third one for
    // workspaces (1/1 on Starter is normal, not an approaching limit).
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);

    // And the 1/1 workspace ratio alone must not trip the upgrade banner
    // (active/archived usage here is well below 75%).
    expect(screen.queryByText("usage.approaching_limit")).toBeNull();

    // The hint links to the upgrade page.
    const upgradeLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/app/settings/account?tab=billing");
    expect(upgradeLinks.length).toBeGreaterThan(0);
  });
});

describe("UsageContent — workspaces card on a multi-workspace plan (Business)", () => {
  it("renders the workspace progress meter and no upgrade hint", async () => {
    setApp({ plan: "business", ownedWorkspaces: 3 });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getAllByRole("progressbar")).toHaveLength(3),
    );
    expect(screen.queryByText(/usage\.workspaces_upgrade_hint/)).toBeNull();
    // 3/10 owned — well under 75%, no banner.
    expect(screen.queryByText("usage.approaching_limit")).toBeNull();
  });

  it("workspace ratio >= 75% still triggers the approaching-limit banner on Business", async () => {
    // 8/10 owned = 80%; active/archived stay low so the banner can only come
    // from the workspace ratio.
    setApp({ plan: "business", ownedWorkspaces: 8 });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getByText("usage.approaching_limit")).toBeTruthy(),
    );
  });
});
