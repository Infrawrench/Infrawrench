import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", schemas: "src/schemas/index.ts" },
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
