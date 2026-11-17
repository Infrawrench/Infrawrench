import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// The Turso driver's addon has no WebAssembly build; where Node itself is
// WebAssembly (Infrawrench CI's runner), the client's own entry without it,
// as in vitest.config.ts.
const libsqlWithoutAddon =
  (process.platform as string) === "wasi"
    ? [{ find: /^@libsql\/client$/, replacement: "@libsql/client/web" }]
    : [];

// One Postgres per worker, when DATABASE_URLS lists them (see below).
const servers = (process.env["DATABASE_URLS"] ?? "").split(",").filter((url) => url.trim());

/**
 * The longest files first, so that with several workers each starts on a
 * worker of its own. Vitest orders a suite it has no timings for by file
 * size, which puts these short files last, and the run then ends a whole
 * 70,000-row sync after everything else has.
 */
class LongestFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const long = (file: TestSpecification) => /\/sync-scale-[^/]*\.test\.ts$/.test(file.moduleId);
    return [...sorted.filter(long), ...sorted.filter((file) => !long(file))];
  }
}

/*
 * Config for the real-database integration tests in `src/__tests__/db/`,
 * excluded from the plain `vitest run` (see vitest.config.ts). Run via
 * `pnpm test:postgres` / `pnpm test:analytics` / `pnpm test:db` with
 * DATABASE_URL set: the suites skip themselves when it is not.
 *
 * Files run serially against one server: the suites write rows, and some of
 * what they test reads every organization's (the CI passes), so two files on
 * one database would read each other's. The timeouts allow for a remote
 * database.
 *
 * To run files side by side, give each worker a database of its own:
 * DATABASE_URLS, a comma-separated list of migrated, separate servers. There
 * are then as many workers as servers, and helpers/worker-database.ts points
 * each worker's DATABASE_URL at its own, so a file still has a whole database
 * to itself for as long as it runs, as it does serially. Infrawrench CI's
 * `postgres-db` job does this.
 */
export default defineConfig({
  resolve: { alias: libsqlWithoutAddon },
  test: {
    environment: "node",
    include: ["src/__tests__/db/**/*.test.ts"],
    setupFiles: ["src/__tests__/helpers/worker-database.ts"],
    fileParallelism: servers.length > 1,
    ...(servers.length > 0 ? { maxWorkers: servers.length } : {}),
    sequence: { sequencer: LongestFirst },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
