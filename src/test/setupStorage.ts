// Vitest setup shim — KNOWN_ISSUES #97.
//
// Node ≥22 ships a built-in `globalThis.localStorage` that THROWS on any
// access unless the process was started with `--localstorage-file`. It
// shadows the storage the tests expect (jsdom's, or a simple in-memory one),
// so every component test that touches localStorage/sessionStorage failed on
// modern local Node while passing on CI's Node 20. Replace a broken built-in
// with an in-memory implementation; leave a working one (e.g. jsdom's) alone.

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function works(get: () => Storage | undefined): boolean {
  try {
    const s = get();
    if (!s) return false;
    s.setItem("__vitest_probe__", "1");
    s.removeItem("__vitest_probe__");
    return true;
  } catch {
    return false;
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (!works(() => (globalThis as Record<string, unknown>)[name] as Storage | undefined)) {
    Object.defineProperty(globalThis, name, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}
