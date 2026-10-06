"use strict";
/**
 * What every module in `gateway-only-modules.json` resolves to inside an edge
 * Worker bundle (wired up by each Worker's wrangler `alias` map).
 *
 * Importing it is free and never throws, so a module graph that merely
 * *reaches* a Node-only library still loads. Using it (calling or
 * constructing anything off it) throws an error carrying the
 * `IW_GATEWAY_ONLY` code, which the edge router and edge poller recognise
 * (`src/runtime/gateway-only.ts`) and answer by handing the work to the Node
 * gateway. Kept as CommonJS so esbuild treats named imports from it as
 * dynamic property reads rather than failing the build on a missing export.
 *
 * The prototype trap matters: esbuild's CJS interop copies a module's own
 * properties onto an object whose prototype is the module's prototype, so a
 * named import (`import { Client } from "ssh2"`) is resolved through
 * `getPrototypeOf`, not `get`.
 */
const CODE = "IW_GATEWAY_ONLY";
const MARKER = "[gateway-only]";

const HIT_HOOK = Symbol.for("infrawrench.gatewayOnlyHit");

function fail(path) {
  // Tell the runtime before throwing: the caller may well swallow the error
  // (plugins fall back to placeholders), and the edge must still know.
  const hook = globalThis[HIT_HOOK];
  if (typeof hook === "function") hook(path);
  const err = new Error(`${MARKER} ${path} needs the Node gateway and cannot run on the edge`);
  err.name = "GatewayOnlyError";
  err.code = CODE;
  throw err;
}

function member(path, key) {
  // `then` must stay undefined or awaiting a stub would hang on a thenable,
  // and symbols (Symbol.toPrimitive, Symbol.iterator) are probes, not use.
  if (key === "then" || typeof key === "symbol") return undefined;
  if (key === "__esModule") return false;
  return make(`${path}.${key}`);
}

function make(path) {
  const target = function () {};
  const proto = new Proxy({}, { get: (_t, key) => member(path, key) });
  return new Proxy(target, {
    get(t, key) {
      // `class X extends Stub {}` reads `prototype`, and it has to be an object.
      if (key === "prototype") return t.prototype;
      return member(path, key);
    },
    getPrototypeOf: () => proto,
    apply: () => fail(path),
    construct: () => fail(path),
  });
}

module.exports = make("node-only module");
