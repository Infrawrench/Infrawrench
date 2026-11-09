// Makes every relative path the job's JavaScript hands to `fs` absolute
// before it reaches Edge.js, working round a race in wasix-libc (#937).
//
// wasix-libc turns a relative path into an absolute one in a single buffer
// every thread shares, holding its lock only while it copies the working
// directory in. When Node's async `fs` runs on libuv's thread pool, one
// thread can rewrite or free that buffer while another is still using it:
// a read of `.gitignore` opens the working directory instead (EISDIR), or
// another file entirely. An absolute path never reaches that code. The fix
// belongs in wasix-libc (#142, #145 there) and so in Edge.js; until the
// pinned Edge.js has it, this keeps the jobs' own reads honest. Native
// addons, which would bypass it, cannot run in a job.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const absolute = (p) =>
  typeof p === "string" && p.length > 0 && !path.isAbsolute(p) ? path.resolve(p) : p;

/** Wraps `object[name]` so its first `count` arguments are made absolute. */
function wrap(object, name, count) {
  const original = object?.[name];
  if (typeof original !== "function" || original.__iwciAbsolute) return;
  const wrapped = function (...args) {
    for (let i = 0; i < count && i < args.length; i++) args[i] = absolute(args[i]);
    return original.apply(this, args);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
  Object.defineProperty(wrapped, "__iwciAbsolute", { value: true });
  try {
    object[name] = wrapped;
  } catch {
    // A read-only property: leave it.
  }
}

// One path argument.
const ONE = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "lchmod",
  "lchown",
  "lutimes",
  "utimes",
  "exists",
  "lstat",
  "stat",
  "statfs",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readdir",
  "readFile",
  "readlink",
  "realpath",
  "rm",
  "rmdir",
  "truncate",
  "unlink",
  "writeFile",
  "watch",
  "watchFile",
  "unwatchFile",
  "createReadStream",
  "createWriteStream",
  "glob",
];
// Two: a source and a destination.
const TWO = ["copyFile", "cp", "link", "rename"];

for (const name of ONE) {
  wrap(fs, name, 1);
  wrap(fs, `${name}Sync`, 1);
  wrap(fs.promises, name, 1);
}
for (const name of TWO) {
  wrap(fs, name, 2);
  wrap(fs, `${name}Sync`, 2);
  wrap(fs.promises, name, 2);
}
// A symlink's target means what it says relative to the link: only the
// link's own path is made absolute.
for (const [object, name] of [
  [fs, "symlink"],
  [fs, "symlinkSync"],
  [fs.promises, "symlink"],
]) {
  const original = object[name];
  if (typeof original !== "function") continue;
  object[name] = function (target, link, ...rest) {
    return original.call(this, target, absolute(link), ...rest);
  };
}
if (fs.realpathSync.native) wrap(fs.realpathSync, "native", 1);
if (fs.realpath.native) wrap(fs.realpath, "native", 1);

// `import { readFile } from "node:fs"` reads a copy of the exports taken
// when the module was first imported; bring it up to date.
require("node:module").syncBuiltinESMExports();
