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
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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
