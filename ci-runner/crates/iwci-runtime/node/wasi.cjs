// `node:wasi` for the runner's Node: the built-in one when it works,
// otherwise a WASI written in JavaScript (@tybys/wasm-util, vendored beside
// this file) over Node's own `fs`. See preload.cjs.
"use strict";

const nodeFs = require("node:fs");

function builtIn() {
  try {
    const wasi = process.getBuiltinModule?.("node:wasi");
    if (!wasi) return null;
    new wasi.WASI({ version: "preview1" });
    return wasi;
  } catch {
    return null;
  }
}

// wasm-util opens files with Linux open(2) flags (O_RDONLY is 0, O_CREAT
// 0x40). This Node is built on wasi-libc, whose O_* constants differ
// (O_RDONLY is 0x4000000, O_CREAT 0x1000), and it rejects Linux values
// with EINVAL, so they are translated.
const C = nodeFs.constants;
const LINUX_FLAGS = [
  [0x40, "O_CREAT"],
  [0x80, "O_EXCL"],
  [0x100, "O_NOCTTY"],
  [0x200, "O_TRUNC"],
  [0x400, "O_APPEND"],
  [0x800, "O_NONBLOCK"],
  [0x1000, "O_DSYNC"],
  [0x101000, "O_SYNC"],
  [0x10000, "O_DIRECTORY"],
  [0x20000, "O_NOFOLLOW"],
];
const translate =
  C.O_RDONLY === 0
    ? (flags) => flags
    : (flags) => {
        if (typeof flags !== "number") return flags;
        let out = [C.O_RDONLY, C.O_WRONLY, C.O_RDWR][flags & 3] ?? C.O_RDONLY;
        for (const [bit, name] of LINUX_FLAGS) {
          if ((flags & bit) === bit && C[name] !== undefined) out |= C[name];
        }
        return out;
      };

const fs = Object.create(nodeFs);
fs.openSync = (path, flags, mode) => nodeFs.openSync(path, translate(flags), mode);
fs.open = (path, flags, ...rest) => nodeFs.open(path, translate(flags), ...rest);
// `promises` is a getter on `fs`, so it is defined rather than assigned.
const promises = Object.create(nodeFs.promises);
promises.open = (path, flags, mode) => nodeFs.promises.open(path, translate(flags), mode);
Object.defineProperty(fs, "promises", { value: promises, enumerable: true });

function javascriptWasi() {
  const { WASI: JsWASI } = require("./wasm-util.cjs");
  class WASI extends JsWASI {
    constructor(options = {}) {
      super({ ...options, fs });
    }
  }
  return { WASI };
}

// Assigned by name, not as `module.exports = ...`: Node exposes a CommonJS
// module's names to `import { WASI } from "node:wasi"` only when it can see
// them without running the module, and rolldown's worker threads import it
// that way. A worker that cannot is never heard from again, and rolldown
// waits for it forever.
exports.WASI = (builtIn() ?? javascriptWasi()).WASI;
