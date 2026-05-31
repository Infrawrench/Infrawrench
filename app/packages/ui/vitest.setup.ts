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

// @testing-library/react only auto-registers afterEach cleanup when Vitest
// globals are enabled. This config doesn't enable globals, so register the
// teardown explicitly to keep the jsdom DOM isolated between tests.
afterEach(() => {
  cleanup();
});
