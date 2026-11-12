// `node-pty` in a job on the runner, where its addon has no WebAssembly build
// (see ../node-preload.cjs): for code that imports it without opening a
// terminal. Opening one fails, as it would without the addon; a test that
// needs a terminal mocks the module, which Vitest does before this is reached.
"use strict";

function unavailable() {
  throw new Error("node-pty: no terminal on Infrawrench CI's runner (its addon is native code)");
}

exports.spawn = unavailable;
exports.fork = unavailable;
exports.createTerminal = unavailable;
exports.open = unavailable;
exports.native = null;
