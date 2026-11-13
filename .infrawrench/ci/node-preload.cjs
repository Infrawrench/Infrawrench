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
// 2. The Cloudflare adapter refuses to load where `process.versions` names a
//    WebContainer, as the runner's Node does, because workerd cannot run
//    there; `astro check` never starts it (see 1), so Astro's command line
//    does not see the name.
//
// 3. `fs.cpSync` of a directory throws EACCES (#1075). Node 24 copies a
//    directory in C++ unless the call has a `filter`, and that copy is what
//    fails; with one it walks the tree in JavaScript, which works. So a
//    recursive call without a filter is given one that keeps everything.
//    `ray build` (the Raycast extension) and the VS Code extension's
//    package script both copy directories this way. The runner's own fix
//    (its `sendfile` writes to files) makes this unneeded; remove it once
//    the runner these jobs run on is a release with that fix.
"use strict";

const fs = require("node:fs");
const mod = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

  const cpSync = fs.cpSync;
  fs.cpSync = function (src, dest, options) {
    if (options?.recursive && !options.filter) {
      options = { ...options, filter: () => true };
    }
    return cpSync.call(this, src, dest, options);
  };
  // `import { cpSync } from "node:fs"` reads the export, not the property.
  mod.syncBuiltinESMExports();

  if (/[\\/]astro[\\/]bin[\\/]astro\.mjs$/.test(process.argv[1] ?? "")) {
    const { webcontainer: _, ...versions } = process.versions;
    Object.defineProperty(process, "versions", {
      ...Object.getOwnPropertyDescriptor(process, "versions"),
      value: versions,
    });
  }

  if (/[\\/]esbuild-wasm[\\/]bin[\\/]esbuild$/.test(process.argv[1] ?? "")) {
    // esbuild-wasm's command line, the process its API starts, replaces
    // `fs.writeSync` for the standard streams with `process.stdout.write`
    // and `process.stderr.write`, to work around a Node bug with split
    // UTF-8. When a stream is a file, as a job's stderr is, `process.stderr`
    // is a SyncWriteStream, which writes with `fs.writeSync` again: each
    // write queues another until the queue overflows ("Invalid array
    // length"), under Node too. So there, the standard streams that are
    // files write with the original.
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
