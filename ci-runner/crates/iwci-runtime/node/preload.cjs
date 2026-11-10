// Loaded into every `node` of an environment job (`NODE_OPTIONS=--require`)
// to give it a `node:wasi` that works. Edge.js ships the module, but not the
// binding behind it, so `new WASI()` throws, and every package whose native
// addon has a `wasm32-wasi` build to fall back on (rolldown, and so Vite,
// Vitest and tsdown; oxc; the Astro compiler) fails to load.
//
// The hook only answers `node:wasi` and `wasi`, and wasi.cjs hands back the
// built-in module untouched whenever its WASI can be constructed, so a
// future Edge.js with a working one is used as is.
"use strict";

// Relative paths to `fs`, made absolute first (absolute-paths.cjs, #937).
require("./absolute-paths.cjs");
// A pending WebAssembly compile keeps the process alive, as in Node (#943).
require("./wasm-keep-alive.cjs");
// A blob's stream ends even when the blob has an empty part (#940).
require("./blob-stream.cjs");

const mod = require("node:module");

if (typeof mod.registerHooks === "function") {
  const url = require("node:url").pathToFileURL(require.resolve("./wasi.cjs")).href;
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:wasi" || specifier === "wasi") {
        return { url, format: "commonjs", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
