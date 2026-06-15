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

// Same thenable shape as emptyLeasesBuilder, but resolves the rows shape the
// component's archived-leases query returns (note the joined `profiles` object
// the component flattens into archived_by_name).
function leasesBuilder(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    builder[m] = vi.fn(() => builder);
  }
  (builder as { then: unknown }).then = (
    res: (v: unknown) => unknown,
    rej?: (e: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error: null }).then(res, rej);
  return builder;
}

interface SetAppArgs {
  plan: import("@/config/pricing").SubscriptionPlan;
  ownedWorkspaces: number;
  activeUsed?: number;
  activeMax?: number;
  archivedUsed?: number;
  archivedMax?: number;
  documentsUsed?: number;
  documentLimit?: number;
  addonDocumentCapacity?: number;
  userRole?: "owner" | "admin" | "editor" | "viewer";
}

function setApp({
  plan,
  ownedWorkspaces,
  activeUsed = 3,
  activeMax = 15,
  archivedUsed = 2,
  archivedMax = 50,
  documentsUsed = 4,
  documentLimit = 15,
  addonDocumentCapacity = 0,
  userRole = "owner",
}: SetAppArgs) {
  useAppMock.mockReturnValue({
    userRole,
    workspace: {
      id: "ws-1",
      plan,
      activeLeasesUsed: activeUsed,
      maxActiveLeases: activeMax,
      archivedLeasesUsed: archivedUsed,
      maxArchivedLeases: archivedMax,
      documentsUsed,
      documentLimit,
      addonDocumentCapacity,
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

    // The abstraction + active + archived meters render — NOT a fourth one
    // for workspaces (1/1 on Starter is normal, not an approaching limit).
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);

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
      expect(screen.getAllByRole("progressbar")).toHaveLength(4),
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

describe("UsageContent — abstraction usage drives the approaching-limit banner", () => {
  it("abstraction ratio >= 75% triggers the banner even when leases/workspaces are low", async () => {
    // 14/15 abstractions = 93%; active/archived/workspace all well below 75%.
    // Before the fix, showUpgrade ignored abstractionPct, so the one metered
    // consumable that drives overage produced a red bar but no upgrade path.
    setApp({
      plan: "starter",
      ownedWorkspaces: 1,
      activeUsed: 1,
      archivedUsed: 1,
      documentsUsed: 14,
      documentLimit: 15,
    });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getByText("usage.approaching_limit")).toBeTruthy(),
    );
  });

  it("abstraction ratio below 75% does NOT trigger the banner", async () => {
    setApp({
      plan: "starter",
      ownedWorkspaces: 1,
      activeUsed: 1,
      archivedUsed: 1,
      documentsUsed: 5,
      documentLimit: 15,
    });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getByText(/usage\.section_plan_usage/)).toBeTruthy(),
    );
    expect(screen.queryByText("usage.approaching_limit")).toBeNull();
  });

  it("non-admin members see the banner but get an 'ask admin' line, not the billing CTA", async () => {
    // A viewer at 14/15 abstractions needs the warning, but the billing tab is
    // admin-gated — so they get a directive line, not a dead-end upgrade button.
    setApp({
      plan: "starter",
      ownedWorkspaces: 1,
      activeUsed: 1,
      archivedUsed: 1,
      documentsUsed: 14,
      documentLimit: 15,
      userRole: "viewer",
    });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getByText("usage.approaching_limit")).toBeTruthy(),
    );
    expect(screen.getByText("usage.ask_admin_upgrade")).toBeTruthy();
    // No billing CTA link in the banner for a non-admin.
    const billingLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/app/settings/account?tab=billing");
    // The workspaces-row upgrade hint link still exists; the banner button does not.
    expect(billingLinks.every((a) => a.textContent !== "usage.upgrade_plan")).toBe(true);
  });
});

describe("UsageContent — Vault read-only retention guard", () => {
  it("renders the read-only note and suppresses metered rows + upgrade CTA", async () => {
    // Vault zeroes all limits; the metered rows would show a meaningless
    // all-zero board and the single-workspace branch's "Upgrade to Business"
    // hint, which contradicts Vault's read-only offramp positioning.
    setApp({
      plan: "vault",
      ownedWorkspaces: 1,
      activeMax: 0,
      archivedMax: 0,
      documentLimit: 0,
    });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getByText("usage.vault_readonly_note")).toBeTruthy(),
    );
    // No bars, no upgrade hint, no approaching-limit banner.
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(screen.queryByText(/usage\.workspaces_upgrade_hint/)).toBeNull();
    expect(screen.queryByText("usage.approaching_limit")).toBeNull();
  });
});

describe("UsageContent — unlimited active leases (activeMax === -1)", () => {
  it("shows the 'Unlimited' right-text, renders no active-lease bar, and omits the count line", async () => {
    // Business carries an unlimited active-lease cap (maxActiveLeases === -1).
    // The active row must read "Unlimited" instead of an N% value, render no
    // progress bar (an unbounded ratio has no meaningful fill), and drop the
    // "N of M" count line (there is no M). The other three metered rows still
    // render their bars, so the active row is the only one missing.
    setApp({
      plan: "business",
      ownedWorkspaces: 3,
      activeUsed: 9999,
      activeMax: -1,
    });
    render(<UsageContent />);
    await waitFor(() =>
      expect(screen.getByText("usage.unlimited")).toBeTruthy(),
    );

    // abstraction + archived + workspaces (Business is multi-workspace) render
    // bars; the active row does NOT — so 3, not 4.
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);

    // The active-lease count line is suppressed: no count_used carrying the
    // 9999 used value. (Other rows still emit count_used with their own values,
    // so we pin the active row's specific interpolation is absent.)
    expect(
      screen.queryByText(/usage\.count_used\(used=9999/),
    ).toBeNull();
  });
});

describe("UsageContent — abstraction descriptor with an add-on document pack", () => {
  it("folds add-on capacity into the effective limit and shows the includes_pack breakdown", async () => {
    // Base plan limit 15 + a 10-lease document pack = effective limit 25. The
    // abstraction descriptor must report count_used against the EFFECTIVE
    // limit (25, not 15) and append the includes_pack breakdown naming the base
    // and the pack size. With 12 used of an effective 25 the ratio is 48% — the
    // pack also pulls the abstraction ratio below 75%, so no banner.
    setApp({
      plan: "business",
      ownedWorkspaces: 3,
      documentsUsed: 12,
      documentLimit: 15,
      addonDocumentCapacity: 10,
    });
    render(<UsageContent />);
    await waitFor(() =>
      expect(
        screen.getByText(/usage\.count_used\(used=12,limit=25\)/),
      ).toBeTruthy(),
    );

    // The pack breakdown names base=15 and the added pack count=10.
    expect(
      screen.getByText(/usage\.includes_pack\(base=15,count=10\)/),
    ).toBeTruthy();
  });
});

describe("UsageContent — populated recent-archives list", () => {
  it("renders an archive row with title, formatted date, and the joined archiver name", async () => {
    fromMock.mockImplementation(() =>
      leasesBuilder([
        {
          id: "lease-1",
          request_title: "Downtown HQ Lease",
          property_address: "100 Main St",
          archived_at: "2026-05-20T12:00:00.000Z",
          archived_by: "user-1",
          profiles: { first_name: "Ada", last_name: "Lovelace" },
        },
      ]),
    );
    setApp({ plan: "business", ownedWorkspaces: 3 });
    render(<UsageContent />);

    // The row uses request_title as its label and links to the lease detail.
    await waitFor(() =>
      expect(screen.getByText("Downtown HQ Lease")).toBeTruthy(),
    );
    const leaseLink = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "/app/leases/lease-1");
    expect(leaseLink).toBeTruthy();

    // archived_by_name is composed from the joined profiles row.
    expect(
      screen.getByText(/usage\.archived_by\(name=Ada Lovelace\)/),
    ).toBeTruthy();

    // archived_at is rendered through date-fns 'MMM d, yyyy'.
    expect(screen.getByText("May 20, 2026")).toBeTruthy();

    // The empty-state copy must NOT show when the list is populated.
    expect(screen.queryByText("usage.recent_archives_empty")).toBeNull();
  });
});
