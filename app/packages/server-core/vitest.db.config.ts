import { defineConfig } from "vitest/config";

// The Turso driver's addon has no WebAssembly build; where Node itself is
// WebAssembly (Infrawrench CI's runner), the client's own entry without it,
// as in vitest.config.ts.
const libsqlWithoutAddon =
  (process.platform as string) === "wasi"
    ? [{ find: /^@libsql\/client$/, replacement: "@libsql/client/web" }]
    : [];

/*
 * Config for the real-database integration tests in `src/__tests__/db/`,
 * excluded from the plain `vitest run` (see vitest.config.ts). Run via
 * `pnpm test:postgres` / `pnpm test:clickhouse` / `pnpm test:db` with the
 * matching env vars set: the suites skip themselves when they are not.
 *
 * Files run serially: both suites talk to shared stateful servers, and the
 * timeouts allow for a cold ClickHouse merge or a remote database.
 */
export default defineConfig({
  resolve: { alias: libsqlWithoutAddon },
  test: {
    environment: "node",
    include: ["src/__tests__/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
