import { describe, it, expect } from "vitest";
import { shouldOpenCommandPalette } from "../cmdKHandler";

// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.1 + §P2.11 MED.
// The Cmd+K listener must coexist with every other modal in the app — Radix
// Dialog/Sheet, in-form typing — without hijacking the keystroke. Each of these
// cases is one of the "gotchas" the spec calls out by name.

function inputs(overrides: Partial<Parameters<typeof shouldOpenCommandPalette>[0]> = {}) {
  return {
    key: "k",
    metaKey: true,
    ctrlKey: false,
    dialogOpen: false,
    newWorkspaceOpen: false,
    focusedTag: null,
    focusedContentEditable: false,
    ...overrides,
  };
}

describe("shouldOpenCommandPalette — gating matrix", () => {
  it("Cmd+K with no modal + no focus -> opens", () => {
    expect(shouldOpenCommandPalette(inputs())).toBe(true);
  });

  it("Ctrl+K (Windows / Linux) also opens", () => {
    expect(
      shouldOpenCommandPalette(inputs({ metaKey: false, ctrlKey: true })),
    ).toBe(true);
  });

  it("plain K with no modifier -> does NOT open", () => {
    expect(shouldOpenCommandPalette(inputs({ metaKey: false, ctrlKey: false }))).toBe(false);
  });

  it("non-K modifier press -> does NOT open", () => {
    expect(shouldOpenCommandPalette(inputs({ key: "j" }))).toBe(false);
    expect(shouldOpenCommandPalette(inputs({ key: "Enter" }))).toBe(false);
  });

  it("suppressed when a Radix Dialog/Sheet is open (data-scroll-locked sentinel)", () => {
    expect(shouldOpenCommandPalette(inputs({ dialogOpen: true }))).toBe(false);
  });

  it("suppressed when the NewWorkspaceDialog state flag is set", () => {
    expect(shouldOpenCommandPalette(inputs({ newWorkspaceOpen: true }))).toBe(false);
  });

  it("suppressed when focus is in an INPUT", () => {
    expect(shouldOpenCommandPalette(inputs({ focusedTag: "INPUT" }))).toBe(false);
  });

  it("suppressed when focus is in a TEXTAREA", () => {
    expect(shouldOpenCommandPalette(inputs({ focusedTag: "TEXTAREA" }))).toBe(false);
  });

  it("suppressed when focus is contenteditable", () => {
    expect(
      shouldOpenCommandPalette(
        inputs({ focusedTag: "DIV", focusedContentEditable: true }),
      ),
    ).toBe(false);
  });

  it("BUTTON or A focus is fine — keystroke still triggers", () => {
    expect(shouldOpenCommandPalette(inputs({ focusedTag: "BUTTON" }))).toBe(true);
    expect(shouldOpenCommandPalette(inputs({ focusedTag: "A" }))).toBe(true);
  });
});
