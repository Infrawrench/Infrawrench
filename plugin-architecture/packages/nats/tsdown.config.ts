import { defineConfig } from "tsdown";

// Two entries: the browser-safe plugin, and the node driver the hosts
// register (only the driver imports the NATS.js client).

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outExtensions({ format }) {
      return {
        js: format === "cjs" ? ".cjs" : ".js",
        dts: format === "cjs" ? ".d.cts" : ".d.ts",
      };
    },
    sourcemap: true,
    deps: { neverBundle: ["@infrawrench/plugin-base"] },
  },
  {
    entry: ["src/driver.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outExtensions({ format }) {
      return {
        js: format === "cjs" ? ".cjs" : ".js",
        dts: format === "cjs" ? ".d.cts" : ".d.ts",
      };
    },
    sourcemap: true,
    deps: {
      neverBundle: [
        "@infrawrench/plugin-base",
        "@nats-io/transport-node",
        "@nats-io/jetstream",
        "@nats-io/kv",
        "@nats-io/obj",
      ],
    },
  },
]);
