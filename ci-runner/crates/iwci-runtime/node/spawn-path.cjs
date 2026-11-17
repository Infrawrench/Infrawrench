// A child's command is looked up on the PATH of the environment it is
// given, as Node does (libuv searches `options.env.PATH`). Edge.js's
// libuv hands WASIX the parent's PATH to search instead, so a tool that
// puts a directory on its child's PATH and runs a command from it found
// nothing (`spawn hello ENOENT`): `pnpm dlx`, and execa's `preferLocal`
// that many CLIs use to run `node_modules/.bin` commands. This resolves the
// name against the child's PATH first and passes the full path, with the
// name as argv[0], when the child's PATH differs from this process's. A
// command run through a shell is left to the shell, which already reads the
// child's PATH.
//
// `patch()` wraps the module's functions the first time it is called.
// preload.cjs calls it when something first asks for `child_process`, not
// at start: loading it loads `net`, `dgram` and the streams too, 28 built-in
// modules and 9 bindings, about a tenth of what a `node -e 0` costs (#996).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

let patched = false;

function resolveOnChildPath(file, options) {
  if (typeof file !== "string" || file === "" || file.includes("/")) return null;
  if (!options || typeof options !== "object" || options.shell || !options.env) return null;
  const childPath = options.env.PATH;
  if (typeof childPath !== "string" || childPath === process.env.PATH) return null;
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  for (const dir of childPath.split(":")) {
    const candidate = path.resolve(cwd, dir, file);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/** Wraps `child_process`'s spawning functions, once. */
function patch() {
  if (patched) return;
  patched = true;
  // Read without `require`, so that the hooks preload.cjs registers are not
  // asked again from inside one of them.
  const cp =
    typeof process.getBuiltinModule === "function"
      ? process.getBuiltinModule("node:child_process")
      : require("node:child_process");
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = cp[name];
    if (typeof original !== "function") continue;
    cp[name] = {
      [name](file, ...rest) {
        const options = rest.find((r) => r !== null && typeof r === "object" && !Array.isArray(r));
        const resolved = resolveOnChildPath(file, options);
        if (resolved === null) return original.call(this, file, ...rest);
        const named = { ...options, argv0: options.argv0 ?? file };
        return original.call(this, resolved, ...rest.map((r) => (r === options ? named : r)));
      },
    }[name];
  }
}

/** Whether a module specifier names `child_process`. */
function isChildProcess(specifier) {
  return specifier === "child_process" || specifier === "node:child_process";
}

module.exports = { patch, isChildProcess };
