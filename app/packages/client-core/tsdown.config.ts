import { defineConfig } from "tsdown";

export default defineConfig({
  // Unbundled: `dist/` mirrors `src/` one module per file, so an app's bundler
  // can drop the parts of the barrel it never uses (`"sideEffects": false` in
  // package.json says it may). Bundled into a single `index.js`, all of it
  // landed in the web SPA's first download whatever the SPA used (#912).
  // Consumers still import the package root; only the files behind it change.
  unbundle: true,
  root: "src",
  // `tunnel-form` is a subpath of its own: it needs the `yaml` parser, which only the
  // hosts that tunnel accounts (server-core, the desktop main process) should load.
  entry: { index: "src/index.ts", "tunnel-form": "src/tunnel-form.ts" },
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
