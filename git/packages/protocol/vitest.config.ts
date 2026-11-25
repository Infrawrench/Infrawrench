import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The interop suites build repositories and run git; the largest indexes a few hundred MiB.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: "forks",
    // One file at a time: this machine is shared, and each file spawns git.
    fileParallelism: false,
    // `--expose-gc` lets the memory test measure what is live, not what is merely uncollected.
    execArgv: ["--expose-gc"],
  },
});
