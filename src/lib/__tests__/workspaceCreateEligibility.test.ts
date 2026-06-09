import { describe, it, expect } from "vitest";
import {
  computeWorkspaceCreateEligibility,
  type WorkspaceLike,
} from "../workspaceCreateEligibility";
import { PLANS } from "../../config/pricing";

// Eligibility matrix for the sidebar's "+ New workspace" entry.
// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.1 + §P2.11 HIGH-polish.
//
// Key invariant: eligibility is derived from the user's OWNED workspaces, NOT
// the active workspace's plan. A Business owner looking at one of their Starter
// workspaces must still see the CTA.

const BUSINESS_CAP = PLANS.business.maxWorkspaces;

function ws(partial: Partial<WorkspaceLike> & { role: string }): WorkspaceLike {
  return {
    plan: "starter",
    subscription_status: null,
    ...partial,
  };
}

function ownerBusinessActive(id = 0): WorkspaceLike {
  return ws({ role: "owner", plan: "business", subscription_status: "active" });
}

describe("computeWorkspaceCreateEligibility — sidebar entry matrix", () => {
  it("Starter (no Business owned): hidden — no CTA, not at cap", () => {
    const result = computeWorkspaceCreateEligibility([
      ws({ role: "owner", plan: "starter", subscription_status: "active" }),
    ]);
    expect(result.hasActiveBusiness).toBe(false);
    expect(result.canCreate).toBe(false);
    expect(result.atCap).toBe(false);
    expect(result.ownedCount).toBe(1);
  });

  it("Business owner under cap (no card / no card scenario is server-only): canCreate=true", () => {
    // No-card is a server-detected reason in `preview`; the client-side
    // affordance still surfaces. The CTA renders; the modal will surface the
    // no_card_on_file branch when the user clicks.
    const result = computeWorkspaceCreateEligibility([ownerBusinessActive()]);
    expect(result.canCreate).toBe(true);
    expect(result.atCap).toBe(false);
    expect(result.hasActiveBusiness).toBe(true);
  });

  it("Business owner at cap: canCreate=false, atCap=true (manage link shown)", () => {
    const ten = Array.from({ length: BUSINESS_CAP }, () => ownerBusinessActive());
    const result = computeWorkspaceCreateEligibility(ten);
    expect(result.ownedCount).toBe(BUSINESS_CAP);
    expect(result.canCreate).toBe(false);
    expect(result.atCap).toBe(true);
  });

  it("Business owner viewing one of their Starter workspaces — CTA still shows", () => {
    // The list contains BOTH an active-Business workspace and a Starter one
    // they own. Eligibility is derived from the OWNED set, not the active
    // workspace. Per HIGH-polish §P2.11.
    const result = computeWorkspaceCreateEligibility([
      ws({ role: "owner", plan: "starter", subscription_status: "active" }),
      ownerBusinessActive(),
    ]);
    expect(result.canCreate).toBe(true);
    expect(result.atCap).toBe(false);
  });

  it("Business workspace where the user is a member (not owner) does NOT count toward eligibility", () => {
    // A member of someone else's Business workspace shouldn't get creation rights.
    const result = computeWorkspaceCreateEligibility([
      ws({ role: "member", plan: "business", subscription_status: "active" }),
      ws({ role: "owner", plan: "starter", subscription_status: "active" }),
    ]);
    expect(result.hasActiveBusiness).toBe(false);
    expect(result.canCreate).toBe(false);
    expect(result.atCap).toBe(false);
    expect(result.ownedCount).toBe(1);
  });

  it("Business workspace owned but past_due / canceled does NOT count as active", () => {
    const result = computeWorkspaceCreateEligibility([
      ws({ role: "owner", plan: "business", subscription_status: "past_due" }),
    ]);
    expect(result.hasActiveBusiness).toBe(false);
    expect(result.canCreate).toBe(false);
  });

  it("Business workspace owned but incomplete (pending payment) does NOT count as active", () => {
    // The brand-new workspace mid-creation is `incomplete`. Until the webhook
    // flips it to `active`, the user should not gain a slot toward creation
    // eligibility via that workspace — but they still get the slot via their
    // OTHER active Business workspace.
    const result = computeWorkspaceCreateEligibility([
      ws({ role: "owner", plan: "business", subscription_status: "incomplete" }),
      ownerBusinessActive(),
    ]);
    expect(result.hasActiveBusiness).toBe(true);
    expect(result.canCreate).toBe(true);
  });

  it("trialing Business sub also counts as active", () => {
    const result = computeWorkspaceCreateEligibility([
      ws({ role: "owner", plan: "business", subscription_status: "trialing" }),
    ]);
    expect(result.hasActiveBusiness).toBe(true);
    expect(result.canCreate).toBe(true);
  });

  it("empty list yields no eligibility", () => {
    const result = computeWorkspaceCreateEligibility([]);
    expect(result.ownedCount).toBe(0);
    expect(result.hasActiveBusiness).toBe(false);
    expect(result.canCreate).toBe(false);
    expect(result.atCap).toBe(false);
  });

  it("at exactly cap-1, canCreate is true; at cap, switches to atCap", () => {
    const justUnder = Array.from({ length: BUSINESS_CAP - 1 }, () =>
      ownerBusinessActive(),
    );
    expect(computeWorkspaceCreateEligibility(justUnder).canCreate).toBe(true);
    expect(computeWorkspaceCreateEligibility(justUnder).atCap).toBe(false);

    const atTen = [...justUnder, ownerBusinessActive()];
    expect(computeWorkspaceCreateEligibility(atTen).canCreate).toBe(false);
    expect(computeWorkspaceCreateEligibility(atTen).atCap).toBe(true);
  });
});
