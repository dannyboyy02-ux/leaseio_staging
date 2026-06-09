import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spec: docs/WORKSPACE_MANAGEMENT_BUILD_SPEC.md §P2.4 + §P2.11 HIGH-sec.
//
// The prefix assertion is the safety net for "wrong-mode key shipped to wrong
// env" — a pk_live_ in staging or a pk_test_ in production would silently route
// real cards to the wrong account. The loader must fail closed (return null) so
// the dialog surfaces the "temporarily unavailable" banner rather than loading
// Stripe with the mismatched key.
//
// We mock @stripe/stripe-js so the tests never reach the real loader, and we
// reset modules between tests so the cached stripePromise singleton doesn't
// bleed across cases.

const loadStripeMock = vi.fn();

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: (...args: unknown[]) => loadStripeMock(...args),
}));

function setEnv(key: string | undefined, mode: string) {
  // Vitest's stubEnv hooks into both process.env and import.meta.env. The Vite
  // SWC transformer keeps import.meta.env.MODE as a live property access (not a
  // build-time literal) when vitest's test runtime intercepts it, so this is
  // the supported way to set per-test env values.
  if (key === undefined) {
    vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", "");
  } else {
    vi.stubEnv("VITE_STRIPE_PUBLISHABLE_KEY", key);
  }
  vi.stubEnv("MODE", mode);
}

describe("getStripe — publishable key prefix assertion (fail closed)", () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loadStripeMock.mockReset();
    loadStripeMock.mockResolvedValue({ marker: "stripe-instance" });
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    consoleErrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("returns null when VITE_STRIPE_PUBLISHABLE_KEY is missing (empty string)", async () => {
    setEnv(undefined, "development");
    const { getStripe } = await import("../stripe");
    expect(getStripe()).toBeNull();
    expect(loadStripeMock).not.toHaveBeenCalled();
  });

  it("production + pk_live_ -> calls loadStripe", async () => {
    setEnv("pk_live_abc123", "production");
    const { getStripe } = await import("../stripe");
    const promise = getStripe();
    expect(promise).not.toBeNull();
    expect(loadStripeMock).toHaveBeenCalledWith("pk_live_abc123");
  });

  it("production + pk_test_ -> fails closed (returns null, logs error, never calls loadStripe)", async () => {
    setEnv("pk_test_oops", "production");
    const { getStripe } = await import("../stripe");
    expect(getStripe()).toBeNull();
    expect(loadStripeMock).not.toHaveBeenCalled();
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
    // Must NOT log the actual key.
    const logged = String(consoleErrSpy.mock.calls[0][0]);
    expect(logged).not.toContain("pk_test_oops");
    expect(logged).toContain("MODE=production");
  });

  it("staging (mode=development) + pk_test_ -> calls loadStripe", async () => {
    setEnv("pk_test_abc123", "development");
    const { getStripe } = await import("../stripe");
    const promise = getStripe();
    expect(promise).not.toBeNull();
    expect(loadStripeMock).toHaveBeenCalledWith("pk_test_abc123");
  });

  it("staging (mode=development) + pk_live_ -> fails closed (real cards on staging)", async () => {
    setEnv("pk_live_real_key", "development");
    const { getStripe } = await import("../stripe");
    expect(getStripe()).toBeNull();
    expect(loadStripeMock).not.toHaveBeenCalled();
    expect(consoleErrSpy).toHaveBeenCalledTimes(1);
    const logged = String(consoleErrSpy.mock.calls[0][0]);
    expect(logged).not.toContain("pk_live_real_key");
    expect(logged).toContain("MODE=development");
  });

  it("non-production with arbitrary mode names still requires pk_test_", async () => {
    setEnv("pk_live_x", "preview");
    const { getStripe } = await import("../stripe");
    expect(getStripe()).toBeNull();
  });

  it("caches the Stripe promise across calls within a module instance", async () => {
    setEnv("pk_test_abc", "development");
    const mod = await import("../stripe");
    const p1 = mod.getStripe();
    const p2 = mod.getStripe();
    expect(p1).toBe(p2);
    // loadStripe should only have been called once across both invocations.
    expect(loadStripeMock).toHaveBeenCalledTimes(1);
  });

});
