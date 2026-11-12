// `workerd` in a job on the runner, where it has no binary (see
// ../node-preload.cjs): for code that imports it without starting it. The
// binary's path is one that does not exist, so starting it fails as it would
// anywhere workerd is missing; the version is the installed package's.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

let version = "0.0.0";
const real = globalThis[Symbol.for("iwci.stub.workerd")];
if (real) {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(real)), "..", "package.json");
    version = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch {
    // Keep the placeholder: nothing that loads it here reads the version.
  }
}

// workerd's versions are 1.YYYYMMDD.N, and its compatibility date is that day.
const day = /^\d+\.(\d{4})(\d{2})(\d{2})\./.exec(version);

// Shaped as the real entry point is (esbuild's CommonJS output of an ES
// module), so `require("workerd").default` is the path there too.
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = "/nonexistent/workerd";
exports.compatibilityDate = day ? `${day[1]}-${day[2]}-${day[3]}` : "2000-01-01";
exports.version = version;
