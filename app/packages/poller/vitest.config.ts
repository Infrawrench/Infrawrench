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

export default {
  resolve: { alias: libsqlWithoutAddon },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
};
