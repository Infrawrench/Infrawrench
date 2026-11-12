// Loaded into every `node` of the jobs in test.yml that set
// NODE_OPTIONS=--require to it, after the runner's own preload. It does
// nothing outside the runner (`process.platform` is "wasi" there).
//
// What this repository's tests and checks need of Node on the runner that
// the runner does not give them yet.
//
// 1. Native packages. The runner's installer keeps a package's `wasm32`
//    optional dependencies, which is how rolldown, oxc and the Astro
//    compiler load. Some packages the jobs load have no such build:
//
//    - Rollup, esbuild and Lightning CSS ship theirs as other packages
//      (`@rollup/wasm-node`, `esbuild-wasm`, `lightningcss-wasm`). Vite 6,
//      which web's and desktop's Vitest runs on, imports the first two
//      before it reads vitest.config.ts, and the website's Tailwind plugin
//      the third. A package that lists one of those builds among its own
//      dependencies gets it in place of the native package.
//    - workerd and node-pty have no WebAssembly build at all, and both throw
//      on import while looking for their binary. `astro check` imports
//      workerd (through the Cloudflare adapter and miniflare) without
//      starting it, and web's and desktop's tests import node-pty without
//      opening a terminal, so stubs/ answers for them: importing works,
//      starting one fails.
//
//    Both go by where a module resolves to, not by what it was asked for as,
//    since Vitest imports its externals by their resolved paths.
//
// 2. Edge.js differences, each until the runner's Node has the fix:
//    - its structuredClone drops an object's integer-like keys
//      (`{ "200": ... }`, an OpenAPI document's responses) and does not keep
//      shared references (#1048). Node's own is V8's serializer, which
//      Edge.js has working, so that answers instead;
//    - its `fs.rmSync` and `fs.rmdirSync` with `recursive` remove nothing
//      and report success (#1049), so a directory is walked instead.
//
// 3. The Cloudflare adapter refuses to load where `process.versions` names a
//    WebContainer, as the runner's Node does, because workerd cannot run
//    there; `astro check` never starts it (see 1), so Astro's command line
//    does not see the name.
"use strict";

const fs = require("node:fs");
const mod = require("node:module");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const WASM_BUILDS = new Map([
  ["rollup", "@rollup/wasm-node"],
  ["esbuild", "esbuild-wasm"],
  ["lightningcss", "lightningcss-wasm"],
]);

const STUBS = new Map(
  ["workerd", "node-pty"].map((name) => [
    name,
    pathToFileURL(path.join(__dirname, "stubs", `${name}.cjs`)).href,
  ]),
);

/** The package a resolved module belongs to, and the path inside it. */
const IN_PACKAGE = /^.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/;

if (process.platform === "wasi" && typeof mod.registerHooks === "function") {
  // Jobs run in their package's directory, and so do Vitest's workers.
  const parentURL = pathToFileURL(path.join(process.cwd(), "package.json")).href;
  const localRequire = mod.createRequire(parentURL);
  const listed = new Set(
    [...WASM_BUILDS.values()].filter((wasm) => {
      try {
        localRequire.resolve(wasm);
        return true;
      } catch {
        return false;
      }
    }),
  );

  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const match = IN_PACKAGE.exec(resolved.url);
      if (!match || match[2] === "package.json") return resolved;
      const [, name, subpath] = match;

      const wasm = WASM_BUILDS.get(name);
      if (wasm && listed.has(wasm)) {
        // The same file in the WebAssembly build where it has one (Rollup's
        // and esbuild's have the native package's layout), else its entry.
        try {
          return nextResolve(`${wasm}/${subpath}`, { ...context, parentURL });
        } catch {
          return nextResolve(wasm, { ...context, parentURL });
        }
      }

      const stub = STUBS.get(name);
      if (stub) {
        // Where the real one is, for its version.
        globalThis[Symbol.for(`iwci.stub.${name}`)] = resolved.url;
        return { url: stub, format: "commonjs", shortCircuit: true };
      }
      return resolved;
    },
  });

  const { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } = fs;
  const removeTree = (target) => {
    if (lstatSync(target).isDirectory()) {
      for (const entry of readdirSync(target)) removeTree(path.join(target, entry));
      rmdirSync(target);
    } else {
      unlinkSync(target);
    }
  };
  const removeRecursively = (target, force) => {
    try {
      removeTree(target instanceof URL ? fileURLToPath(target) : String(target));
    } catch (err) {
      if (!(force && err?.code === "ENOENT")) throw err;
    }
  };
  fs.rmSync = function (target, options) {
    if (options?.recursive) return removeRecursively(target, options.force);
    return rmSync(target, options);
  };
  fs.rmdirSync = function (target, options) {
    if (options?.recursive) return removeRecursively(target, false);
    return rmdirSync(target, options);
  };
  // `import { rmSync } from "node:fs"` reads the patched ones too.
  mod.syncBuiltinESMExports();

  if (/[\\/]astro[\\/]bin[\\/]astro\.mjs$/.test(process.argv[1] ?? "")) {
    const { webcontainer: _, ...versions } = process.versions;
    Object.defineProperty(process, "versions", {
      ...Object.getOwnPropertyDescriptor(process, "versions"),
      value: versions,
    });
  }

  const v8 = require("node:v8");
  const nativeClone = globalThis.structuredClone;
  globalThis.structuredClone = function structuredClone(value, options) {
    if (options?.transfer?.length) return nativeClone(value, options);
    try {
      return v8.deserialize(v8.serialize(value));
    } catch {
      // Something V8's serializer leaves to the host, such as a Blob.
      return nativeClone(value, options);
    }
  };

  // esbuild-wasm's command line, the process its API starts, needs two
  // things Node gives it and this one does not.
  if (/[\\/]esbuild-wasm[\\/]bin[\\/]esbuild$/.test(process.argv[1] ?? "")) {
    // Go's WebAssembly runtime opens files read-only with the numeric flags
    // 0, which is O_RDONLY in Node everywhere but is no access mode at all
    // in Edge.js, whose constants are WASI's (O_RDONLY is 0x4000000): every
    // open fails with EINVAL (#1045).
    const { O_RDONLY, O_WRONLY, O_RDWR } = fs.constants;
    if (O_RDONLY !== 0) {
      const withMode = (flags) =>
        typeof flags === "number" && (flags & (O_RDONLY | O_WRONLY | O_RDWR)) === 0
          ? flags | O_RDONLY
          : flags;
      const { open, openSync } = fs;
      fs.open = (file, flags, ...rest) => open(file, withMode(flags), ...rest);
      fs.openSync = (file, flags, ...rest) => openSync(file, withMode(flags), ...rest);
    }

    // It replaces `fs.writeSync` for the standard streams with
    // `process.stdout.write` and `process.stderr.write`, to work around a
    // Node bug with split UTF-8. When a stream is a file, as a job's stderr
    // is, `process.stderr` is a SyncWriteStream, which writes with
    // `fs.writeSync` again: each write queues another until the queue
    // overflows ("Invalid array length"), under Node too. So there, the
    // standard streams that are files write with the original.
    const { Writable } = require("node:stream");
    const writeSync = fs.writeSync;
    for (const [name, fd] of [
      ["stdout", 1],
      ["stderr", 2],
    ]) {
      if (process[name].constructor.name !== "SyncWriteStream") continue;
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          try {
            for (let at = 0; at < chunk.length;) at += writeSync(fd, chunk, at);
            callback();
          } catch (err) {
            callback(err);
          }
        },
      });
      stream.fd = fd;
      Object.defineProperty(process, name, { configurable: true, enumerable: true, value: stream });
    }
  }
}
