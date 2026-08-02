import { defineConfig } from "tsdown";

// Two entries (package + node driver). The driver is a separate bundle so the
// browser-side plugin never pulls `node:fs` into the renderer graph.

export default defineConfig([
  {
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
    deps: { neverBundle: ["@infrawrench/plugin-base"] },
  },
  {
    entry: ["src/node-driver.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outExtensions({ format }) {
      return {
        js: format === "cjs" ? ".cjs" : ".js",
        dts: format === "cjs" ? ".d.cts" : ".d.ts",
      };
    },
    sourcemap: true,
    deps: { neverBundle: ["@infrawrench/plugin-base"] },
  },
]);
