// A rolldown build on its wasm32-wasi binding that asks for a diagnostic
// report from a plugin hook, mid-build, while the binding's WebAssembly
// threads wait: what yuku-codegen's `isMusl` does when tsdown loads its
// declaration plugin. The report needs every worker's part, so it hung.
import { build } from "rolldown";

let workers = -1;
const out = await build({
  input: "src/index.js",
  plugins: [
    {
      name: "report",
      load(id) {
        if (id.endsWith("greet.js")) workers = process.report.getReport().workers.length;
        return null;
      },
    },
  ],
  output: { dir: "dist", format: "esm" },
});
if (workers < 1) throw new Error(`the report listed ${workers} workers`);
console.log(`built ${out.output.map((chunk) => chunk.fileName).join(",")}`);
