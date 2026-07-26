import { defineConfig } from "tsup";

// NOTE: no `clean: true` here. With two configs tsup runs them concurrently,
// and a clean declared on one can wipe output the other has already emitted —
// which is how `dist/driver.d.cts` went missing in CI while the build log said
// it was written (desktop's typecheck then failed on a package it hadn't
// touched). The build script does `rm -rf dist` once, before either starts.

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    external: ["@infrawrench/plugin-base"],
  },
  {
    entry: ["src/driver.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    external: ["@infrawrench/plugin-base", "@kubernetes/client-node"],
  },
]);
