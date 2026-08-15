import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Standalone React-free entry so server-side consumers (the web API) can
    // import the agent shell-command builders without loading UI components.
    "agents/launch-command": "src/agents/launch-command.ts",
    // Same split for the T3 Code session helpers: the web API builds its
    // bootstrap/connect commands and its setup plan server-side.
    "agents/t3-code": "src/agents/t3-code.ts",
    // React-free cost widget config schemas — imported by the web API for
    // request/config validation as well as by the widget editors.
    "cost/config": "src/cost/config.ts",
    // React-free metric alert rule schemas — same split, same consumer.
    "metric-alerts/config": "src/metric-alerts/config.ts",
    // React-free API key scope catalog. The web test suite asserts it against
    // the server's permission catalog, and importing the component barrel into
    // a Node context to read a data table is not worth Monaco and React.
    "settings/api-key-scopes": "src/settings/api-key-scopes.ts",
    // React-free prompt bridge. Data-layer modules (the desktop cloud client,
    // the web workflow transport) raise prompts without pulling in the whole
    // component barrel — importing that into a Node context drags Monaco and
    // React along and times imports out.
    "workflows/prompt-bridge": "src/workflows/prompt-bridge.ts",
  },
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
  deps: { neverBundle: ["react", "react-dom", "@infrawrench/plugin-base"] },
});
