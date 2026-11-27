/**
 * What the deployed bundle is made of.
 *
 * The Worker calls the app's CI (`@infrawrench/server-core/ci/git-events`,
 * `ci/runs`), and that code can reach the plugin loader, the socket drivers
 * and through them libraries that cannot run in a Worker. The app's own
 * Workers live with that reach: each keeps an `alias` map in its
 * wrangler.jsonc that turns every library in server-core's
 * `edge/gateway-only-modules.json` into a stub, and a test that the map and
 * the list agree. This Worker has no such map, because its bundle reaches
 * none of them: with `__INFRAWRENCH_EDGE_PLUGINS__` defined, server-core's
 * dispatcher drops the code that lends (`ci/runs.ts` `lendingCode`), which
 * was the only path there.
 *
 * So the check here is the bundle itself: `wrangler deploy --dry-run` builds
 * what a deploy would upload, and its metafile lists every module in it. A
 * new import that brings the loader, a plugin or a gateway-only library back
 * fails here, with the chain of imports that did it, instead of shipping a
 * Worker that dies when it loads (or one three times the size).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORKER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATEWAY_ONLY = fileURLToPath(
  new URL(
    "../../node_modules/@infrawrench/server-core/edge/gateway-only-modules.json",
    import.meta.url,
  ),
);

/**
 * The upload's script, uncompressed. It was 3.4 MB when the registry left
 * it (November 2026; 9.0 MB before), and 5.9 MB before the link preview
 * renderer, whose JavaScript (Satori and its text shaping, about 0.8 MB) is
 * evaluated only by the image route (`og/mount.ts`); its WebAssembly and
 * fonts are modules of their own, outside this file. The room above that is
 * for the forge to grow into, not for server-core: something that adds
 * megabytes at once is a reach worth looking at before it ships. It reached
 * 6 999 039 bytes of the 7 000 000 it was first held to with push mirrors
 * and issue import; the pack serving of #1447 added 16 kB of the forge's own
 * code and the bound moved with it.
 */
const MAX_BUNDLE_BYTES = 7_500_000;

/** Parts of server-core this Worker must never carry, each with what it would bring. */
const FORBIDDEN_SOURCES: ReadonlyArray<readonly [fragment: string, why: string]> = [
  ["/server-core/src/plugin-loader.ts", "the plugin loader"],
  ["/server-core/src/plugin-registry", "the plugin registry (3.5 MB of metadata, or every plugin)"],
  ["/server-core/src/drivers.ts", "the socket drivers"],
  ["/server-core/src/host-services.ts", "the plugin host services"],
  ["/server-core/src/ci/lend.ts", "CI's lending, which calls plugins"],
  ["/server-core/edge/gateway-only-stub.cjs", "a gateway-only library's stub"],
  // ci-reads-ignore: a fragment matched against the bundle's module list, not a path read here
  ["/plugin-architecture/packages/", "a plugin, a driver or plugin-base"],
];

interface Metafile {
  readonly inputs: Record<string, { readonly imports: ReadonlyArray<{ readonly path: string }> }>;
  readonly outputs: Record<string, { readonly inputs?: Record<string, unknown> }>;
}

let dir = "";
let meta: Metafile;
let bundled: string[] = [];
let output = "";

/** The imports that lead from the entry to `target`, for a failure that says what to undo. */
function chainTo(target: string): string {
  const entry = "src/index.ts";
  if (meta.inputs[entry] === undefined) return target;
  const from = new Map<string, string | null>([[entry, null]]);
  const queue: string[] = [entry];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const { path } of meta.inputs[at]?.imports ?? []) {
      if (from.has(path) || meta.inputs[path] === undefined) continue;
      from.set(path, at);
      queue.push(path);
    }
  }
  const chain: string[] = [];
  for (let at: string | null | undefined = target; at != null; at = from.get(at)) chain.push(at);
  return chain
    .reverse()
    .map((path) => path.replace(/^(\.\.\/)+/, ""))
    .join("\n  -> ");
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "git-worker-bundle-"));
  // The UI's build is not this test's business: an empty directory stands in for `../web/dist`.
  mkdirSync(join(dir, "assets"));
  const run = spawnSync(
    process.execPath,
    [
      join(WORKER_ROOT, "node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      "--assets",
      join(dir, "assets"),
      "--outdir",
      join(dir, "out"),
      "--metafile",
      join(dir, "meta.json"),
    ],
    {
      cwd: WORKER_ROOT,
      encoding: "utf8",
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
    },
  );
  output = `${run.stdout}${run.stderr}`;
  if (run.status !== 0) throw new Error(`wrangler deploy --dry-run failed:\n${output}`);
  meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Metafile;
  bundled = Object.values(meta.outputs).flatMap((out) => Object.keys(out.inputs ?? {}));
});

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("the deployed bundle", () => {
  it("is the Worker", () => {
    expect(bundled).toContain("src/index.ts");
    expect(bundled.length).toBeGreaterThan(100);
  });

  it("carries no plugin code and nothing that loads it", () => {
    const found = FORBIDDEN_SOURCES.flatMap(([fragment, why]) =>
      bundled
        .filter((path) => `/${path}`.includes(fragment))
        .slice(0, 1)
        .map((path) => `${why}:\n  ${chainTo(path)}`),
    );
    expect(found).toEqual([]);
  });

  it("reaches no library that cannot run in a Worker, so it needs no alias map", () => {
    const { modules } = JSON.parse(readFileSync(GATEWAY_ONLY, "utf8")) as { modules: string[] };
    expect(modules.length).toBeGreaterThan(10);
    const found = modules.flatMap((name) =>
      bundled
        .filter((path) => path.includes(`/node_modules/${name}/`))
        .slice(0, 1)
        .map((path) => `${name}:\n  ${chainTo(path)}`),
    );
    expect(found).toEqual([]);
    // And nothing to drift: an alias here would be a third copy of the app's map.
    expect(readFileSync(join(WORKER_ROOT, "wrangler.jsonc"), "utf8")).not.toMatch(/"alias"\s*:/);
  });

  it("stays the size it was measured at", () => {
    const size = statSync(join(dir, "out/index.js")).size;
    expect(size).toBeLessThan(MAX_BUNDLE_BYTES);
  });
});
