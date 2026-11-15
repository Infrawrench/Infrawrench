// pnpm makes its global package directory first, which it does not do
// itself under Edge.js's pnpm settings. With `node-linker=hoisted` and a
// `store-dir` set, which Edge.js's pnpm has, `pnpm add -g` (and `npm i -g`,
// which Edge.js runs as pnpm) resolves into a lockfile-only install first
// and writes `<global-dir>/5/pnpm-lock.yaml` before anything has made
// `<global-dir>/5`, so the first global install of a job failed with ENOENT
// (pnpm 10.34.5; the same on Linux and macOS Node with those settings).
// Making the directory is all a later run would have found there.
"use strict";

const path = require("node:path");

function globalPackageDir(env) {
  const configured = env.npm_config_global_dir || env.NPM_CONFIG_GLOBAL_DIR;
  const root = configured || (env.PNPM_HOME && path.join(env.PNPM_HOME, "global"));
  // pnpm's LAYOUT_VERSION, the directory under the global dir it installs into.
  return root && path.isAbsolute(root) ? path.join(root, "5") : null;
}

const script = process.argv[1] || "";
const args = process.argv.slice(2);
if (/[\\/](edge-)?pnpm\.c?js$/.test(script) && args.some((a) => a === "-g" || a === "--global")) {
  const dir = globalPackageDir(process.env);
  if (dir) {
    try {
      require("node:fs").mkdirSync(dir, { recursive: true });
    } catch {
      // pnpm reports whatever is wrong with the directory itself.
    }
  }
}
