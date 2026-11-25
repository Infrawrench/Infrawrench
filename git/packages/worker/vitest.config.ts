import { defineConfig } from "vitest/config";

// The suites in `src/__tests__/db/` need a migrated Postgres and run through
// vitest.db.config.ts (`pnpm test:db`). Everything else needs nothing but git,
// and the workerd suites (opt-in, GIT_WORKER_E2E=1) also start wrangler.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["src/__tests__/db/**", "node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    // One file at a time: this machine is shared, and each file spawns git or workerd.
    fileParallelism: false,
    // `--expose-gc` lets the memory measurement see what is live, not what is merely uncollected.
    execArgv: ["--expose-gc"],
  },
});
