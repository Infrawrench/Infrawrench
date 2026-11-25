import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The suites build repositories and run git; the largest makes 5 000 commits.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: "forks",
    // One file at a time: this machine is shared, and each file spawns git.
    fileParallelism: false,
  },
});
