import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { prebundle, SERVER_CORE_PREBUNDLED } from "./vitest.prebundle";

/*
 * Shadow run of the mocked Postgres suites (`pnpm test:postgres:shadow`): the
 * same unit tests, unchanged and in place, but with `helpers/fake-postgres.ts`
 * also PREPARE-validating every captured statement against the real server at
 * DATABASE_URL; see the shadow-mode notes in that helper. Collection is by
 * content, not location: any `src/__tests__` suite using the helper is picked
 * up automatically, so migrating a suite off its hand-rolled db stub is what
 * enrols it here.
 *
 * Files run in parallel: nothing is executed, so they share no rows, and the
 * helper names each file's statements apart for a server whose connections
 * share one session (Infrawrench CI's pglite-server).
 *
 * The packages nearly every file imports are bundled once per run, with the
 * list vitest.config.ts uses (vitest.prebundle.ts): these are that config's
 * files, run a second time, and most of this run was each file's process
 * loading the same modules again.
 */
const testsDir = "src/__tests__";
const include = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => readFileSync(join(testsDir, name), "utf8").includes("helpers/fake-postgres"))
  .map((name) => `${testsDir}/${name}`);

// The Turso driver's addon has no WebAssembly build; where Node itself is
// WebAssembly (Infrawrench CI's runner), the client's own entry without it,
// as in vitest.config.ts.
const libsqlWithoutAddon =
  (process.platform as string) === "wasi"
    ? [{ find: /^@libsql\/client$/, replacement: "@libsql/client/web" }]
    : [];

export default defineConfig({
  resolve: { alias: libsqlWithoutAddon },
  test: {
    environment: "node",
    deps: prebundle([...SERVER_CORE_PREBUNDLED, "@infrawrench/plugin-base > effect"]),
    include,
    env: { INFRAWRENCH_SHADOW_POSTGRES: "1" },
    globalSetup: ["src/__tests__/helpers/shadow-postgres-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
