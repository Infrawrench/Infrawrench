// Makes `Blob.prototype.stream()` finish when the blob has an empty part
// (#940).
//
// A blob's native reader hands its parts to the stream one per pull, empty
// ones included, and the stream's pull (lib/internal/blob.js) enqueues
// nothing for an empty part. Node then reads on unless the stream is over
// its high-water mark (`c.desiredSize < 0`). Edge.js changed that test to
// `<= 0` (wasmerio/edgejs 3abea55, still on main), and with the stream's
// high-water mark of 0 it ends the pull right there: the read that asked
// for data is still waiting and nothing calls pull again. So a stream over
// `new Blob([""])`, `new Blob(["a", ""])` or `fs.openAsBlob()` of an empty
// file never ends, and neither does anything built on one
// (`new Response(blob)`, a `CompressionStream` piped from it). `text()` and
// `arrayBuffer()` take another path and work.
//
// Each blob's reader is wrapped as its stream is made, so a pull passes over
// empty parts and answers with the next part or the end. An empty part adds
// no bytes, so a reader sees the same stream it would in Node. Remove this
// once the pinned Edge.js reads on at `c.desiredSize === 0` again.
"use strict";

/** The blob's private handle: Node and Edge.js keep it under `Symbol(kHandle)`. */
function handleOf(blob) {
  const key = Object.getOwnPropertySymbols(blob).find((s) => s.description === "kHandle");
  const handle = key === undefined ? undefined : blob[key];
  return handle !== null && typeof handle === "object" && typeof handle.getReader === "function"
    ? handle
    : undefined;
}

/** Wraps a reader so `pull` passes over empty parts. */
function skippingEmpty(reader) {
  const pull = reader.pull;
  if (typeof pull !== "function") return reader;
  reader.pull = function (callback) {
    const next = () =>
      pull.call(this, (status, buffer) => {
        if (status === 1 && buffer !== undefined && buffer.byteLength === 0) return next();
        return callback(status, buffer);
      });
    return next();
  };
  return reader;
}

if (typeof Blob === "function" && typeof Blob.prototype.stream === "function") {
  const wrapped = new WeakSet();
  const original = Blob.prototype.stream;
  const { stream } = {
    stream(...args) {
      const handle = this !== null && typeof this === "object" ? handleOf(this) : undefined;
      if (handle !== undefined && !wrapped.has(handle)) {
        const getReader = handle.getReader;
        handle.getReader = function (...readerArgs) {
          return skippingEmpty(getReader.apply(this, readerArgs));
        };
        wrapped.add(handle);
      }
      return original.apply(this, args);
    },
  };
  Object.defineProperty(Blob.prototype, "stream", {
    value: stream,
    writable: true,
    configurable: true,
  });
}
