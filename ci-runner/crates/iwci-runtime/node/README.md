# Node preload for environment jobs

The runner's Node is Edge.js. This directory fills four gaps between it and
Node; each file can go once the pinned Edge.js closes its gap.

## `node:wasi`

Edge.js (`env:bash-node`) ships the `node:wasi` module without the binding
behind it, so `new WASI()` throws. Every package whose native addon falls
back to a `wasm32-wasi` build needs it: rolldown (and through it Vite,
Vitest and tsdown), oxc, the Astro compiler. The runner writes these files
to `/usr/local/lib/iwci/node` in every environment job and puts
`--require /usr/local/lib/iwci/node/preload.cjs` first in `NODE_OPTIONS`:

- `preload.cjs` answers `node:wasi` (and `wasi`) with `wasi.cjs`, through
  `module.registerHooks`, so `require` and `import` both see it, in worker
  threads too.
- `wasi.cjs` returns the built-in module when its `WASI` can be constructed,
  so an Edge.js that fixes it is used as is. Otherwise it returns
  `@tybys/wasm-util`'s WASI, written in JavaScript, over Node's `fs`, with
  Linux `open(2)` flags translated to wasi-libc's.
- `wasm-util.cjs` is `dist/wasm-util.js` of `@tybys/wasm-util` 0.10.4 (MIT,
  `wasm-util.LICENSE`), with one line changed. Its build replaced
  `process.env.NODE_DEBUG_NATIVE` with the literal `"wasi"` (0.10.3 too), so
  it traced every WASI call to `console.debug`; `syscallWrap` reads the
  environment again, so `NODE_DEBUG_NATIVE=wasi` still turns the trace on.
  It needs nothing at run time.
  Integrity of the published tarball:
  `sha512-W3c4gRigFS0T/Ma4qIYF3GDAc5AQdHb1yL5znJT1Zv1YaD9Kitx656wBjvr19qbiosmZT8lWDM5BEMynUqX65A==`.

To update it, take `dist/wasm-util.js` from the new version's tarball, check
the tarball against the registry's integrity, record both here, and redo the
`NODE_DEBUG_NATIVE` line if the new build still hard-codes it. Remove
the whole directory once the pinned Edge.js has a working `node:wasi`:
`wasi.cjs` already prefers it, so nothing breaks in between.

## Relative paths (#937)

wasix-libc makes a relative path absolute in one buffer that every thread
shares, so two of Node's `fs` calls on libuv's thread pool can trade paths: a
read opens the working directory (EISDIR) or another file.
`absolute-paths.cjs` resolves the path arguments of `fs`, `fs.promises` and
their sync forms before they reach it, then calls
`module.syncBuiltinESMExports()` so `import { readFile } from "node:fs"`
sees the same functions. A symlink's target is left alone, because it is
relative to the link. `builtins/test.sh`'s `relative-reads-passes` does 40,000
concurrent reads of four files and checks each one's contents. Without the
preload, 40 to 69 per run came back wrong. Remove it once Edge.js carries
wasix-libc #142 and #145.

As of November 2026 none does. Both pull requests are open, the newest
sysroot (`v2026-10-02.1`) still shares the buffer, Edge.js 0.2.5 is the newest
`wasmer/edgejs` release, and Edge.js `main` still builds on that sysroot.
Fixing it ourselves means building Edge.js's WASIX module from source
(`make build-wasix` with `wasixcc` 0.4.7: OpenSSL, libuv-wasix and Edge.js's
C++ for `wasm32-wasix`) against a sysroot whose `libc.a` has
`libc-bottom-half/sources/chdir.c` from #145, then packaging it with its
`node-lib/`, ICU data, npm and pnpm as Edge.js's release does, and
publishing that webc ourselves rather than pinning Wasmer's.

## A pending WebAssembly compile (#943)

Node does not exit while `WebAssembly.compile` or `instantiate` is compiling
on V8's background threads. Edge.js can: under load, about one process in
fifteen exited silently with the compile unfinished. It also does not wake
its event loop when the compile finishes, so a long timer kept the process
waiting forever. `wasm-keep-alive.cjs` holds a 5 ms interval while any of
the four async entry points is pending, which keeps the process alive and
picks up the result.

## Empty blob parts (#940)

A blob's native reader hands the stream one part per pull, empty parts
included, and the stream enqueues nothing for an empty one. Node then reads
on unless the stream is over its high-water mark (`c.desiredSize < 0`);
Edge.js changed that to `<= 0` (wasmerio/edgejs 3abea55, still on `main`),
and at a high-water mark of 0 the pull ends with the read still waiting. So a
stream over `new Blob([""])`, `new Blob(["a", "", "b"])` or `fs.openAsBlob()`
of an empty file never ends, nor does `new Response(blob)` or a
`CompressionStream` piped from one, which is how #940 showed up.
`blob-stream.cjs` wraps each blob's reader as its stream is made so a pull
passes over empty parts. An empty part carries no bytes, so readers see what
they would in Node. `builtins/test.sh`'s `blob-stream-passes` covers it;
remove the file once Edge.js's `lib/internal/blob.js` tests `< 0` again.
