import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each file loads client-core's barrel and runs real git; on a busy
    // machine the first test of a file can take longer than the default 5 s.
    testTimeout: 30_000,
  },
});
