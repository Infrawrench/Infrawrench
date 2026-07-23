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
