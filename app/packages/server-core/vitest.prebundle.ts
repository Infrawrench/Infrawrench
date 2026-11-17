import { builtinModules } from "node:module";

/*
 * Packages nearly every test file loads, bundled once per run into a few files
 * each (Vite's dependency optimizer) instead of being read module by module in
 * every test file's process. Vitest starts a `node` per test file, and each one
 * loaded `effect` (some 500 files), `drizzle-orm` (250) and client-core's dist
 * (190) again: on Infrawrench CI's runner, where reading a module costs about a
 * millisecond, that was about half of web's 445 s of imports in a run and more
 * of server-core's.
 *
 * Rules for the lists:
 * - A package belongs here only if most test files import it and it has no
 *   native addon.
 * - List every entry point the code under test imports. The bundles share one
 *   copy of each module between the entries listed; an entry left out is loaded
 *   from its own files beside the bundled copy, so a class would exist twice.
 * - A package that a listed one bundles and the code under test also imports
 *   itself is listed too, for the same reason: drizzle-orm's Postgres driver
 *   bundles `postgres`, which db/client.ts imports.
 * - Not a CommonJS package that tests mock. Bundled, its named imports are read
 *   off a default export, so a `vi.mock` of it that returns named exports
 *   stops satisfying the import.
 * - `a > b` names a package `b` by way of `a`, for a package the test's own
 *   package.json does not list (server-core has no `effect`; plugin-base does).
 *   Any import of `b` that resolves to that same package then gets the bundle.
 *
 * What a `vi.mock` reaches is unchanged for the npm packages: they were never
 * run through Vite, so a mock of `postgres` never reached drizzle-orm's own
 * import of it. For the workspace packages one thing changes: a mock of a
 * listed package no longer reaches another listed package's imports of it
 * (client-core's of plugin-base, api-contract's of client-core), since those
 * are now inside the bundles. Source files and plugins importing it still get
 * the mock.
 *
 * `force` rebuilds the bundles on every run (about a second): the optimizer's
 * cache is keyed on the lockfile and the config, not on a workspace package's
 * dist, so a rebuilt client-core would otherwise be tested as it was when the
 * cache was written.
 *
 * Node's built-in modules are excluded by name because the optimizer resolves a
 * bare `buffer` or `events` to the npm package of that name when one is
 * installed, and would bundle that polyfill in place of the built-in
 * (the request signer in plugin-base imports `buffer`).
 */

/** What server-core's own tests and everything that tests against its source load. */
export const SERVER_CORE_PREBUNDLED = [
  "drizzle-orm",
  "drizzle-orm/pg-core",
  "drizzle-orm/pg-proxy",
  "drizzle-orm/postgres-js",
  "drizzle-orm > postgres",
  "@infrawrench/client-core",
  "@infrawrench/plugin-base",
  "@infrawrench/plugin-base/effect",
  "@infrawrench/plugin-base/test-harness",
  "@infrawrench/plugin-base/validation",
];

/** The `test.deps` of a Vitest config that prebundles `include`. */
export function prebundle(include: readonly string[]) {
  return {
    optimizer: {
      ssr: { enabled: true, force: true, include: [...include], exclude: [...builtinModules] },
    },
  };
}
