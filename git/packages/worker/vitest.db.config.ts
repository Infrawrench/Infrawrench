import { defineConfig } from "vitest/config";

/*
 * The real-database suites in `src/__tests__/db/`: the API served end to end
 * against a migrated Postgres, for what only the database can prove
 * (visibility filtering in SQL, numbering under concurrency, the
 * protected-branch checks a merge reads, the queue consumer's idempotency).
 *
 * `DATABASE_URL=postgres://... pnpm test:db`, scratch databases only: the
 * suites write users, organisations and repositories and delete them after.
 * They skip themselves without `DATABASE_URL`. Files run one at a time, as
 * server-core's do (its vitest.db.config.ts says why).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
