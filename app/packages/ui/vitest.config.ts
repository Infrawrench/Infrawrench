import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    // jsdom + RTL under a saturated `turbo test` regularly overruns the 5s
    // default even for trivial renders; keep the suite green at the cost of a
    // slower failure signal.
    testTimeout: 20_000,
  },
});
