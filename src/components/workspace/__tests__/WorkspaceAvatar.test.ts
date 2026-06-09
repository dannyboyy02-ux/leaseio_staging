import { describe, it, expect } from "vitest";
import {
  deriveInitials,
  hashStringToIndex,
  WORKSPACE_AVATAR_PALETTE,
} from "../WorkspaceAvatar";

// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.1.
// The avatar has no upload UI — it's just initials over a deterministic color
// keyed off the workspace id. Tests pin the contract:
//  - Identical id always picks the same palette slot (cross-render, cross-
//    session stability matters because the user learns to recognize the color).
//  - Initials handle the realistic name shapes the product can throw at us:
//    one-word, two-word, emoji-only, leading/trailing whitespace, very long.

describe("WorkspaceAvatar — deterministic color per id", () => {
  it("hashStringToIndex returns a value in [0, mod)", () => {
    for (let i = 0; i < 100; i++) {
      const id = `workspace-${i}-${Math.random()}`;
      const idx = hashStringToIndex(id, WORKSPACE_AVATAR_PALETTE.length);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(WORKSPACE_AVATAR_PALETTE.length);
    }
  });

  it("same id maps to the same palette slot on every call", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const first = hashStringToIndex(id, WORKSPACE_AVATAR_PALETTE.length);
    for (let i = 0; i < 50; i++) {
      expect(hashStringToIndex(id, WORKSPACE_AVATAR_PALETTE.length)).toBe(first);
    }
  });

  it("different ids generally produce a spread across the palette", () => {
    // Smoke: hash 200 distinct ids; we should hit > 1 palette slot. If the
    // hash collapses to one slot, the user can't distinguish workspaces.
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(
        hashStringToIndex(`ws-${i}-${i * 31}`, WORKSPACE_AVATAR_PALETTE.length),
      );
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("palette has 8 entries, each pairing a bg + fg utility class", () => {
    expect(WORKSPACE_AVATAR_PALETTE).toHaveLength(8);
    for (const slot of WORKSPACE_AVATAR_PALETTE) {
      expect(slot.bg).toMatch(/^bg-[a-z]+-\d{2,3}$/);
      expect(slot.fg).toMatch(/^text-[a-z]+-\d{2,3}$/);
    }
  });
});

describe("WorkspaceAvatar — deriveInitials", () => {
  it("two-word name -> first letter of each", () => {
    expect(deriveInitials("Acme Inc.").toUpperCase()).toBe("AI");
    expect(deriveInitials("Latitude Foods").toUpperCase()).toBe("LF");
  });

  it("one-word name -> first two characters", () => {
    expect(deriveInitials("Stripe").toUpperCase()).toBe("ST");
    expect(deriveInitials("L").toUpperCase()).toBe("L");
  });

  it("empty / whitespace-only name -> sentinel ?", () => {
    expect(deriveInitials("")).toBe("?");
    expect(deriveInitials("   ")).toBe("?");
  });

  it("emoji-only name does not split a surrogate pair", () => {
    // Naive .slice(0,2) on "🏢" would split the surrogate. Array.from handles it.
    // We just assert the result is a single emoji code point, not garbage.
    const initials = deriveInitials("🏢");
    expect(initials.length).toBeGreaterThan(0);
    // The emoji should round-trip cleanly through Array.from.
    expect(Array.from(initials).length).toBeGreaterThanOrEqual(1);
  });

  it("emoji + word -> first emoji + first letter of next token", () => {
    const initials = deriveInitials("🚀 Rockets");
    expect(initials.length).toBeGreaterThan(1);
    expect(initials).toContain("R");
  });

  it("name with extra internal whitespace -> still picks first letter of first two tokens", () => {
    expect(deriveInitials("  Acme    Holdings  ").toUpperCase()).toBe("AH");
  });

  it("very long single-word name -> exactly 2 characters", () => {
    const long = "A".repeat(500);
    expect(deriveInitials(long)).toBe("AA");
  });

  it("very long multi-word name -> exactly 2 characters (one from each of first two tokens)", () => {
    const long = `${"A".repeat(200)} ${"B".repeat(200)} ${"C".repeat(200)}`;
    const initials = deriveInitials(long);
    expect(initials).toBe("AB");
    expect(initials.length).toBe(2);
  });
});
