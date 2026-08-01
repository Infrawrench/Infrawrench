import { defineConfig } from "tsdown";

// Two entries (package + node driver). tsdown runs array configs without the
// old tsup clean race; default clean:true is fine.

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
    entry: ["src/driver.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outExtensions({ format }) {
      return {
        js: format === "cjs" ? ".cjs" : ".js",
        dts: format === "cjs" ? ".d.cts" : ".d.ts",
      };
    },
    sourcemap: true,
    deps: { neverBundle: ["@infrawrench/plugin-base", "dockerode"] },
  },
]);
