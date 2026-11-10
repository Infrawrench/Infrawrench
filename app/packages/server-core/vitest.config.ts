import { configDefaults, defineConfig } from "vitest/config";

/*
 * The Turso driver's `@libsql/client` loads a native addon on import, and the
 * addon has no WebAssembly build. Where Node itself is WebAssembly (Infrawrench
 * CI's runner) the driver gets the client's own entry without the addon: the
 * same client for a remote database, and an error for a local file, which no
 * test here opens.
 */
const libsqlWithoutAddon =
  (process.platform as string) === "wasi"
    ? [{ find: /^@libsql\/client$/, replacement: "@libsql/client/web" }]
    : [];

export default defineConfig({
  resolve: { alias: libsqlWithoutAddon },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Real-database integration tests live in src/__tests__/db and run via
    // vitest.db.config.ts (`pnpm test:db`), never in the plain unit run.
    exclude: [...configDefaults.exclude, "src/__tests__/db/**"],
    /*
     * Several suites here `await import(...)` inside the test body or a
     * beforeEach: the only way to load a module after `vi.doMock`, and the
     * only way to reach ESM-only packages from CJS. That cold import happens
     * inside the test/hook budget, and under a fully parallel `turbo test`
     * run across ~30 packages it can overrun the 5s/10s defaults on a loaded
     * machine. The result is a suite that passes alone and fails
     * intermittently in CI, which is worse than a slow one.
     */
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
