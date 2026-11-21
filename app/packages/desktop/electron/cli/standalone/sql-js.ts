// `../../sql-js.ts` in the standalone CLI: the WebAssembly binary is inlined
// by the build (esbuild's `binary` loader for `.wasm`), because a single
// executable has no `node_modules` to read it from.
import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasm from "sql.js/dist/sql-wasm.wasm";

export function loadSqlJs(): Promise<SqlJsStatic> {
  const bytes = wasm.slice();
  return initSqlJs({ wasmBinary: bytes.buffer });
}
