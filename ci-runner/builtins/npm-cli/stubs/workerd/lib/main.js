// Stands in for `workerd`, Cloudflare's local Workers runtime, in the CI
// runner's Node tools (ci-runner/README.md, "Deployment CLIs"). workerd is a
// native program, and a job is a WebAssembly isolate: the real package's
// `lib/main.js` throws "Unsupported platform: wasi wasm32 LE" as soon as it
// is loaded, and Wrangler loads it (through Miniflare) to start at all.
// This exports what the real one does: the path to a `workerd`, which here
// explains itself and exits, and the release it stands in for.
"use strict";

const path = require("node:path");

module.exports = {
  __esModule: true,
  default: path.join(__dirname, "..", "bin", "workerd"),
  compatibilityDate: "2026-11-13",
  version: "1.20261113.1",
};
