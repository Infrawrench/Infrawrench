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
    // Cold barrel imports (cloud-api, plugin loader) stretch past the 5s
    // default when `turbo test` is saturating the machine.
    testTimeout: 20_000,
  },
});
