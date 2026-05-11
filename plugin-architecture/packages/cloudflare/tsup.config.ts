import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Bundle (and tree-shake) the cloudflare SDK into the plugin output so the
  // host doesn't need to ship it separately. The SDK is ~36 MB unpacked, but
  // we only call a small slice of namespaces, so esbuild should drop the rest.
  noExternal: ["cloudflare"],
  external: ["@infrawrench/plugin-base"],
});
