import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The interop tests start real ssh and git processes.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // git.test.ts measures what the server still holds while 128 MiB goes
    // through it, which needs the collector on demand.
    execArgv: ["--expose-gc"],
  },
});
