// Loads sql.js with its WebAssembly binary. Its own module so the standalone
// CLI (`scripts/build-cli.mjs`) can swap in `cli/standalone/sql-js.ts`, which
// carries the binary inside the bundle: a single executable has no
// `node_modules` to find `sql-wasm.wasm` in.
import path from "node:path";
import initSqlJs, { type SqlJsStatic } from "sql.js";

export function loadSqlJs(): Promise<SqlJsStatic> {
  const sqlJsMain = require.resolve("sql.js");
  const wasmPath = path.join(path.dirname(sqlJsMain), "sql-wasm.wasm");
  return initSqlJs({ locateFile: () => wasmPath });
}
