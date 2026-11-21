import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { initializeGTSPA } from "gt-react";

// gt-react hooks (useGT, <T>) read a singleton that the app entrypoints
// initialize before rendering. Give tests the same singleton, English-only and
// offline, so shared components render their source strings.
await initializeGTSPA({
  defaultLocale: "en",
  locales: ["en"],
  loadTranslations: async () => ({}),
});

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

// Testing Library gives `waitFor` and the `findBy*` queries one second before
// they fail. That is a wall-clock budget for work no timer paces: mocked
// fetches resolving, React committing, a whole panel rendering in jsdom. Under
// a saturated `turbo test` it overruns (the CI panel's first render in
// ci-panel.test.tsx took over a second with the machine busy, and some 50 ms
// alone), so a test failed on load rather than on what it checks. The test's
// own limit (`testTimeout` in vitest.config.ts) already allows for that; give
// the queries the same room. A condition that holds is still seen as soon as it
// does, and one that never holds still fails, only later.
configure({ asyncUtilTimeout: 15_000 });
