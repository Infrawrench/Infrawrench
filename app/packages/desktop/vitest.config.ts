import { builtinModules, createRequire } from "node:module";
import type { Plugin as EsbuildPlugin } from "esbuild-wasm";
import { defineConfig } from "vitest/config";

/*
 * `electron` in plain Node is the path to the Electron binary, which its install script writes
 * down; without that file the import throws. Where Node itself is WebAssembly (Infrawrench CI's
 * runner) no install script runs and there is no binary to point at, so the path is made up:
 * no test here starts Electron.
 */
const electronWithoutBinary =
  (process.platform as string) === "wasi" ? { ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent" } : {};

/*
 * The Turso driver's `@libsql/client` (through the bundled plugins) loads a native addon on
 * import, and the addon has no WebAssembly build: there it gets the client's own entry without
 * the addon, as in server-core's and web's configs. No test here opens a local database file.
 */
const libsqlWithoutAddon =
  (process.platform as string) === "wasi"
    ? [{ find: /^@libsql\/client$/, replacement: "@libsql/client/web" }]
    : [];

/*
 * Packages the node-environment test files load, bundled once per run into a few files each
 * (Vite's dependency optimizer) instead of being read module by module in every test file's
 * process. Vitest starts a `node` per test file, and on Infrawrench CI's runner each module read
 * costs about a millisecond. Alone at two workers, with per-module timing on, the 106 files
 * spent 245 s importing and in setup: `effect` 63 s, `@kubernetes/client-node` 50 s (some 970
 * files, in the 38 test files that reach electron/drivers.ts through the CLI or the plugin
 * host), `gt-react` 22 s (vitest.setup.ts, so every file), `mssql` 14 s, client-core's dist
 * 10 s, the API contract 5 s and `kafkajs` 5 s.
 *
 * server-core/vitest.prebundle.ts has the rules a list like this follows (every entry point the
 * code imports, so no module exists twice; no CommonJS package a test mocks; Node's built-ins
 * excluded by name; `force`, because the optimizer's cache is not keyed on a workspace package's
 * dist). What is particular to this one:
 *
 * - It is the `ssr` optimizer only, which serves the node-environment files. The one jsdom file
 *   runs in Vite's `client` environment, where `resolve.conditions` below picks gt-react's
 *   browser build; it loads everything as before. In the `ssr` environment these packages
 *   resolve as Node resolves them (gt-react to its server build, `ws` to the real one), bundled
 *   or not.
 * - No package with a native addon anywhere beneath it. esbuild cannot bundle a `.node` file,
 *   and the addon is only missing on the runner, so such a list passes there and fails to start
 *   on a developer's machine: `dockerode` is left out for ssh2's, though it is the next largest.
 *   `@libsql/client`, `mysql2`, `ioredis`, `pg` and the NATS clients are left out because they
 *   are 1 to 3 s of a run each. `@infrawrench/ui` is left out because eight files mock it and
 *   only four load its barrel.
 * - `a > b` names `b` by way of `a`, for a driver's client this package does not list itself.
 * - No source maps for the bundles (`sourcemap: false`). Writing them was 6 of the 13 s the
 *   bundling took on the runner (esbuild's WebAssembly build, one thread), and the test
 *   processes read them too: the suite alone at two workers took 87 s with them and 72 s
 *   without. A stack frame inside one of these packages then names the bundle
 *   (`deps_ssr/effect.js`) with its function, rather than the package's own file; frames in
 *   this package's code are unchanged.
 *
 * A `vi.mock` of `@infrawrench/plugin-base` or client-core no longer reaches another listed
 * package's own imports of it (client-core's of plugin-base, the API contract's of client-core),
 * since those are inside the bundles; source files and plugins importing it still get the mock.
 */
const prebundled = [
  "effect",
  "effect/cli",
  "effect/encoding",
  "effect/http",
  "effect/http-api",
  "effect/net",
  "effect/process",
  "effect/rpc",
  "effect/socket",
  "gt-react",
  "@infrawrench/api-contract",
  "@infrawrench/api-contract/schemas",
  "@infrawrench/client-core",
  "@infrawrench/plugin-base",
  "@infrawrench/plugin-base/effect",
  "@infrawrench/plugin-base/validation",
  "@kubernetes/client-node",
  "@infrawrench/plugin-kafka > kafkajs",
  "@infrawrench/plugin-mssql > mssql",
];

/*
 * `require("process/")`, with the slash, is how a package asks for the npm package named like a
 * built-in rather than the built-in (readable-stream under mssql asks for `process/` and
 * `string_decoder/` that way). The optimizer's `exclude` of the built-ins matches those too and
 * leaves them as imports nothing can resolve from the bundle's directory, so they are resolved
 * here to the package Node would have loaded, from the file that asked.
 */
const npmPackagesNamedLikeBuiltins: EsbuildPlugin = {
  name: "npm-packages-named-like-builtins",
  setup(build) {
    build.onResolve({ filter: /^[a-z_]+\/$/ }, ({ path, resolveDir }) => ({
      path: createRequire(`${resolveDir}/`).resolve(path),
    }));
  },
};

export default defineConfig({
  // gt-react's default export condition is a server build whose SPA setup
  // refuses to run; the renderer's components need the browser one.
  resolve: {
    conditions: ["browser"],
    alias: libsqlWithoutAddon,
  },
  test: {
    include: ["src/**/*.test.ts", "electron/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    env: electronWithoutBinary,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          force: true,
          include: prebundled,
          exclude: [...builtinModules],
          esbuildOptions: { plugins: [npmPackagesNamedLikeBuiltins], sourcemap: false },
        },
      },
    },
    // Cold barrel imports (cloud-api, plugin loader) stretch past the 5s
    // default when `turbo test` is saturating the machine.
    testTimeout: 20_000,
  },
});
