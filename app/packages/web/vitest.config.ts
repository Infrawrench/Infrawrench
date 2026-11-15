import { defineConfig } from "vitest/config";
import path from "path";
import { prebundle, SERVER_CORE_PREBUNDLED } from "../server-core/vitest.prebundle";

/*
 * The Turso driver's `@libsql/client` loads a native addon on import, and the addon has no
 * WebAssembly build. Where Node itself is WebAssembly (Infrawrench CI's runner) the driver gets
 * the client's own entry without the addon: the same client for a remote database, and an error
 * for a local file, which no test here opens. server-core's and poller's configs do the same.
 */
const libsqlWithoutAddon =
  (process.platform as string) === "wasi"
    ? [{ find: /^@libsql\/client$/, replacement: "@libsql/client/web" }]
    : [];

/*
 * The packages bundled once per run rather than loaded module by module in every test file's
 * process; server-core's vitest.prebundle.ts has what belongs in the list and why. Web adds what
 * its own code imports on top of server-core's: `effect` and the API contract.
 */
const prebundled = [
  ...SERVER_CORE_PREBUNDLED,
  "effect",
  "effect/http",
  "effect/http-api",
  "@infrawrench/api-contract",
  "@infrawrench/api-contract/schemas",
];

export default defineConfig({
  test: {
    environment: "node",
    deps: prebundle(prebundled),
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Route suites cold-import a large Hono app; under parallel turbo load the
    // 5s default flakes even when the same tests pass alone.
    testTimeout: 20_000,
  },
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname, "src") }, ...libsqlWithoutAddon],
  },
});
