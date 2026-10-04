import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
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
  deps: { neverBundle: ["@infrawrench/plugin-base"] },
});
