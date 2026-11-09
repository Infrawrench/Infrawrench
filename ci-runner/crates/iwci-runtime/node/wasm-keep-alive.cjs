// Keeps the process alive while WebAssembly compiles in the background (#943).
//
// Node does not exit while `WebAssembly.compile` or `instantiate` is still
// compiling on V8's background threads: before it decides the event loop is
// empty, it waits for those tasks. Edge.js does not, so a program whose only
// pending work is a compile can exit before it finishes, silently and with
// status 0. On a busy host that is a few processes in a hundred.
//
// Nor does it wake the event loop when the compile finishes: its result
// waits until something else runs the loop. So one long timer would keep
// the process waiting forever. A short interval held until the compile
// settles both keeps it alive and looks for the result every few ms.
"use strict";

/** How often the loop looks for a finished compile, in ms. */
const POLL_MS = 5;

function holding(original) {
  if (typeof original !== "function") return original;
  return function (...args) {
    const timer = setInterval(() => {}, POLL_MS);
    let result;
    try {
      result = original.apply(this, args);
    } catch (err) {
      clearInterval(timer);
      throw err;
    }
    return Promise.resolve(result).finally(() => clearInterval(timer));
  };
}

for (const name of ["compile", "instantiate", "compileStreaming", "instantiateStreaming"]) {
  const original = WebAssembly[name];
  if (typeof original !== "function") continue;
  Object.defineProperty(WebAssembly, name, {
    value: holding(original),
    writable: true,
    configurable: true,
  });
}
