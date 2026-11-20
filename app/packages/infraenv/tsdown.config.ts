import { defineConfig } from "tsdown";

// One published file per chunk, nothing in node_modules at run time: the
// package has no `dependencies`, so everything it imports (client-core's
// pure modules, kill-emudhra) is inlined here. Each command is a dynamic
// import, so `--version`, `--help` and the hook commands never load the
// HTTP client.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: false,
  sourcemap: false,
  clean: true,
  fixedExtension: true,
  deps: {
    alwaysBundle: [/^@infrawrench\//, "kill-emudhra"],
    onlyBundle: [/^@infrawrench\//, "kill-emudhra"],
  },
  // The shebang on the entry only; the command chunks are imported, never run.
  banner: ({ fileName }) => (fileName === "cli.mjs" ? { js: "#!/usr/bin/env node" } : undefined),
});
