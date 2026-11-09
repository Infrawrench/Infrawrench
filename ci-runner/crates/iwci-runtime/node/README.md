# `node:wasi` for environment jobs

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
