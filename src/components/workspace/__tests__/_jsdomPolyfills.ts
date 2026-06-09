// Shared jsdom polyfills for Radix/cmdk-driven component tests. Import for
// side effects at the top of any test file that mounts these components.
//
// jsdom 29 doesn't ship ResizeObserver, scrollIntoView, or PointerEvent —
// Radix Dialog/Popover/Command rely on them. Without these stubs, mount throws
// "ResizeObserver is not defined" before our test code ever runs.

if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!("PointerEvent" in window)) {
    (window as unknown as { PointerEvent: typeof Event }).PointerEvent = Event as never;
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {};
  }
}
