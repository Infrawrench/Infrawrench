import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "electron/**/*.test.ts"],
    // Cold barrel imports (cloud-api, plugin loader) stretch past the 5s
    // default when `turbo test` is saturating the machine.
    testTimeout: 20_000,
  },
});
