import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement matchMedia; components that read the preferred color
// scheme (e.g. chart theming) rely on it. Provide a no-op default that tests
// can override with vi.spyOn when they need specific behaviour.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom doesn't implement ResizeObserver; recharts' ResponsiveContainer uses it.
if (typeof globalThis !== "undefined" && !("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Node 26 defines an experimental global `localStorage` getter that returns
// undefined unless --localstorage-file is passed, and it shadows jsdom's
// implementation. Give tests a real in-memory Storage when that happens.
if (typeof globalThis !== "undefined" && !globalThis.localStorage) {
  const data = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
  });
}

// @testing-library/react only auto-registers afterEach cleanup when Vitest
// globals are enabled. This config doesn't enable globals, so register the
// teardown explicitly to keep the jsdom DOM isolated between tests.
afterEach(() => {
  cleanup();
});
