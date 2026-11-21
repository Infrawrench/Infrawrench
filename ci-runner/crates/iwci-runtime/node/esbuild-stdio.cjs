// esbuild-wasm's own process (`node bin/esbuild`, which its API starts and
// which the installers put in place of native esbuild) prints a build's
// warnings. Its `bin/esbuild` replaces `fs.writeSync` for fds 1 and 2 with
// `process.stdout.write` and `process.stderr.write`, to work around a Node
// bug with split UTF-8. When the stream is a file, as a job's standard
// error is, `process.stderr` is a SyncWriteStream, which writes with
// `fs.writeSync` again: each write queues another until the queue
// overflows ("RangeError: Invalid array length"), and the process dies
// (Node does the same with `2>file`). In that process only, a standard
// stream that is a file gets a writer that calls the original
// `fs.writeSync`. Edge.js's standard streams are files for pipes too, so
// that is every run.
//
// The process is also `node_modules/.bin/esbuild`, a link to `bin/esbuild`
// (a package script, `npx esbuild`), whose `process.argv[1]` is the link:
// the script is found by where the link leads. It was not, so the queue
// was never written and `esbuild --version` printed nothing (exit 0, the Go
// program exiting at once).
"use strict";

const script = process.argv[1] || "";
if (/[\\/]\.?bin[\\/]esbuild$/.test(script)) {
  const fs = require("node:fs");
  const path = require("node:path");
  let real = script;
  try {
    real = fs.realpathSync(script);
  } catch {}
  // esbuild-wasm under its own name or the native package's.
  if (fs.existsSync(path.join(path.dirname(real), "..", "esbuild.wasm"))) {
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
