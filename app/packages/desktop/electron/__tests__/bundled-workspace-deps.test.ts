import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `externalizeDepsPlugin` leaves every key of `dependencies` as a runtime
 * require and bundles everything else, and electron-builder copies each
 * `dependencies` entry into the asar together with its whole dependency tree.
 * So `dependencies` must hold exactly the packages the main process loads
 * from `node_modules` at runtime, and nothing the build bundles:
 *
 * - A workspace package there is externalized, but electron-builder's `files`
 *   drops `node_modules/@infrawrench/**` from the asar, so the packaged app
 *   throws "Cannot find module" the moment it starts: a lit dock icon and no
 *   window, invisible in dev because dev resolves through the real
 *   `node_modules`. This shipped twice (`appstream-host`, then
 *   `appstream-core`).
 * - A bundled package there ships its tree for nothing. `effect` and
 *   `workflow-runtime` (whose tree is a second copy of the TypeScript compiler
 *   and the QuickJS sandbox) once added about 40 MB to the app this way.
 */
const pkgRoot = resolve(__dirname, "../..");

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const runtimeDeps = Object.keys(pkg.dependencies ?? {});

describe("desktop runtime dependencies", () => {
  it("lists no workspace package under `dependencies`", () => {
    expect(runtimeDeps.filter((name) => name.startsWith("@infrawrench/"))).toEqual([]);
  });

  it("does not externalize the packages the main build relies on bundling", () => {
    // `effect` is ESM-only and the main bundle is CommonJS; the Kubernetes
    // client is ESM-only too, and bundling it tree-shakes its generated API.
    expect(
      runtimeDeps.filter((name) => ["effect", "@kubernetes/client-node"].includes(name)),
    ).toEqual([]);
  });
});
