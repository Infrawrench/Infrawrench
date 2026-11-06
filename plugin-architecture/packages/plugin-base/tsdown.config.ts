import { defineConfig } from "tsdown";

// One config with three entries so they share chunks: `effect` and `validation`
// are subpaths because the root entry must stay free of the Effect runtime for
// the SPA and mobile, and a class seen through two copies fails `instanceof`.
export default defineConfig({
  entry: ["src/index.ts", "src/effect.ts", "src/validation/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  outExtensions({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
      dts: format === "cjs" ? ".d.cts" : ".d.ts",
    };
  },
  sourcemap: true,
  clean: true,
});
