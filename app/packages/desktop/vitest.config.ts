import { defineConfig } from "vitest/config";

export default defineConfig({
  // gt-react's default export condition is a server build whose SPA setup
  // refuses to run; the renderer's components need the browser one.
  resolve: {
    conditions: ["browser"],
  },
  test: {
    include: ["src/**/*.test.ts", "electron/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Cold barrel imports (cloud-api, plugin loader) stretch past the 5s
    // default when `turbo test` is saturating the machine.
    testTimeout: 20_000,
  },
});
