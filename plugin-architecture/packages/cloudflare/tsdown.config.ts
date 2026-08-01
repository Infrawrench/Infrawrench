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
  // Keep `cloudflare` external so each consumer resolves the right env
  // conditional export (the SDK ships separate node/browser/worker shims).
  // Bundling it picked the Node variant, which uses `util.deprecate` and
  // broke Vite's renderer build with a missing `__vite-browser-external`
  // deprecate export.
  deps: { neverBundle: ["@infrawrench/plugin-base", "cloudflare"] },
});
