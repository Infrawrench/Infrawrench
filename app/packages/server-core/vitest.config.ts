import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /*
     * Several suites here `await import(...)` inside the test body or a
     * beforeEach — the only way to load a module after `vi.doMock`, and the
     * only way to reach ESM-only packages from CJS. That cold import happens
     * inside the test/hook budget, and under a fully parallel `turbo test`
     * run across ~30 packages it can overrun the 5s/10s defaults on a loaded
     * machine. The result is a suite that passes alone and fails
     * intermittently in CI, which is worse than a slow one.
     */
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
