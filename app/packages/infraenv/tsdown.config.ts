import { defineConfig, type UserConfig } from "tsdown";

// Nothing in node_modules at run time: the package has no `dependencies`, so
// everything it imports (client-core's pure modules, kill-emudhra) is inlined.
//
// Two builds. ESM carries the CLI (`cli.mjs`, each command a dynamic-import
// chunk, so `--version` and the hook commands never load the HTTP client),
// the library (`index.mjs`, `config.mjs`) and the worker `configSync` runs
// (`load-worker.mjs`); the CLI and the library share chunks but neither
// entry imports the other's code. CJS carries the library for `require`,
// where `config.cjs` is the synchronous variant (`register-sync.ts`).
const shared: UserConfig = {
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: false,
  fixedExtension: true,
  deps: {
    alwaysBundle: [/^@infrawrench\//, "kill-emudhra"],
    onlyBundle: [/^@infrawrench\//, "kill-emudhra"],
  },
};

export default defineConfig([
  {
    ...shared,
    entry: {
      cli: "src/cli.ts",
      index: "src/index.ts",
      config: "src/register.ts",
      "load-worker": "src/load-worker.ts",
    },
    format: ["esm"],
    clean: true,
    // The shebang on the CLI only; every other file is imported, never run.
    banner: ({ fileName }) => (fileName === "cli.mjs" ? { js: "#!/usr/bin/env node" } : undefined),
  },
  {
    ...shared,
    entry: { index: "src/index.ts", config: "src/register-sync.ts" },
    format: ["cjs"],
    clean: false,
    // `import.meta.url` (version.ts finds the package root with it) in CJS.
    shims: true,
  },
]);
