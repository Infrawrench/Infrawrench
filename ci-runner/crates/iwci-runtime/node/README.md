# Node preload for environment jobs

The runner's Node is Edge.js. This directory fills two gaps between it and
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

Not a gap any more, and nothing here covers it. wasix-libc makes a relative
path absolute in one buffer that every thread shares, so two of Node's `fs`
calls on libuv's thread pool could trade paths: a read opened the working
directory (EISDIR) or another file. A preload here once resolved `fs` path
arguments first, which missed Node's own internals and anything a job
overrode. `env:bash-node` (from 24.0.1) fixes it where it is: its Edge.js is
built from source on a C library with wasix-libc #145
(`builtins/environments/edgejs/build.sh`), and `builtins/test.sh`'s
`relative-reads-passes` checks 40,000 concurrent reads by relative path.

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

## A pending WebAssembly compile (#943)

One more gap, `node` exiting while an async `WebAssembly.compile` was still
running and missing its result behind a long timer, was filled here by a
preload that held a 5 ms interval while one was pending. The bridge's V8
platform now waits for that work itself (`vendor/README.md`), so the preload
is gone.
