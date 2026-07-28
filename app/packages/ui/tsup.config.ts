import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Standalone React-free entry so server-side consumers (the web API) can
    // import the agent shell-command builders without loading UI components.
    "agents/launch-command": "src/agents/launch-command.ts",
    // React-free cost widget config schemas — imported by the web API for
    // request/config validation as well as by the widget editors.
    "cost/config": "src/cost/config.ts",
    // React-free prompt bridge. Data-layer modules (the desktop cloud client,
    // the web workflow transport) raise prompts without pulling in the whole
    // component barrel — importing that into a Node context drags Monaco and
    // React along and times imports out.
    "workflows/prompt-bridge": "src/workflows/prompt-bridge.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom", "@infrawrench/plugin-base"],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
