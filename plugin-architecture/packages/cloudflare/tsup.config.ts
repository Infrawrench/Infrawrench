import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep `cloudflare` external so each consumer resolves the right env
  // conditional export (the SDK ships separate node/browser/worker shims).
  // Bundling it picked the Node variant, which uses `util.deprecate` and
  // broke Vite's renderer build with a missing `__vite-browser-external`
  // deprecate export.
  external: ["@infrawrench/plugin-base", "cloudflare"],
});
