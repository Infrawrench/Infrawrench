// Loaded into every `node` of an environment job (`NODE_OPTIONS=--require`)
// to give it a `node:wasi` that works. Edge.js ships the module, but not the
// binding behind it, so `new WASI()` throws, and every package whose native
// addon has a `wasm32-wasi` build to fall back on (rolldown, and so Vite,
// Vitest and tsdown; oxc; the Astro compiler) fails to load.
//
// The hook only answers `node:wasi` and `wasi`, and wasi.cjs hands back the
// built-in module untouched whenever its WASI can be constructed, so a
// future Edge.js with a working one is used as is.
//
// Every `node` pays for what runs here, so nothing here loads a built-in
// that bootstrap has not already loaded: `child_process` is patched the
// first time it is asked for (#996).
"use strict";

// A blob's stream ends even when the blob has an empty part (#940).
require("./blob-stream.cjs");
// pnpm's first global install finds its directory made.
require("./pnpm-global.cjs");
// A child's command is found on the PATH it is given.
const spawnPath = require("./spawn-path.cjs");

const mod = require("node:module");

if (typeof mod.registerHooks === "function") {
  const url = require("node:url").pathToFileURL(require.resolve("./wasi.cjs")).href;
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:wasi" || specifier === "wasi") {
        return { url, format: "commonjs", shortCircuit: true };
      }
      // `require` and `import` of `child_process` both resolve here first.
      if (spawnPath.isChildProcess(specifier)) spawnPath.patch();
      return nextResolve(specifier, context);
    },
  });
  // The one way to a built-in that does not resolve through the hooks.
  const getBuiltinModule = process.getBuiltinModule;
  if (typeof getBuiltinModule === "function") {
    process.getBuiltinModule = {
      getBuiltinModule(id) {
        if (spawnPath.isChildProcess(id)) spawnPath.patch();
        return getBuiltinModule.call(this, id);
      },
    }.getBuiltinModule;
  }
} else {
  spawnPath.patch();
}
