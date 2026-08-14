import { defineConfig } from "vitest/config";

export default defineConfig({
  // gt-react ships separate server and browser entries behind export
  // conditions; without "browser" Vitest resolves the server one, whose
  // initializeGTSPA() refuses to run. The tests render in jsdom, so the
  // browser build is the right one everywhere.
  resolve: {
    conditions: ["browser"],
  },
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
