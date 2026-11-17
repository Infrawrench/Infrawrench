// Stands in for `workerd`, Cloudflare's local Workers runtime, in the CI
// runner's Node tools (ci-runner/README.md, "Deployment CLIs"). workerd is a
// native program, and a job is a WebAssembly isolate: the real package's
// `lib/main.js` throws "Unsupported platform: wasi wasm32 LE" as soon as it
// is loaded, and Wrangler loads it (through Miniflare) to start at all.
// This exports what the real one does: the path to a `workerd`, which here
// exits 1, and the release it stands in for.
//
// Why it cannot run is said here, by the process about to start it, rather
// than by bin/workerd. Miniflare reads `default` only to spawn the runtime,
// and reads what the runtime printed once it has exited, which it learns
// from the child's `exit` event; that can come before the output (#1279).
// Then the explanation was lost, and only "The Workers runtime failed to
// start" remained. Written to this process's own stderr before the spawn,
// it is always there, ahead of that error.
"use strict";

const path = require("node:path");

const bin = path.join(__dirname, "..", "bin", "workerd");

// The explanation, once per process; bin/workerd says it only when nothing
// read `default` first (IWCI_WORKERD_EXPLAINED, which the spawn inherits).
function explain() {
  if (process.env.IWCI_WORKERD_EXPLAINED !== "1") {
    process.env.IWCI_WORKERD_EXPLAINED = "1";
    process.stderr.write(require("./explanation.js"));
  }
  return bin;
}

// Assigned one by one, so that Node's `import("workerd")` finds the names
// too (`wrangler types` reads `version` that way).
exports.__esModule = true;
exports.compatibilityDate = "2026-11-16";
exports.version = "1.20261116.1";
Object.defineProperty(exports, "default", { enumerable: true, get: explain });
