// Bundles the extension into one CommonJS file. `vscode` is provided by the
// host at runtime and is never bundled; everything else, @infrawrench/client-core
// included, is inlined so the packaged extension needs no node_modules.
import { build, context } from "esbuild";

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  minify: process.argv.includes("--minify"),
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
