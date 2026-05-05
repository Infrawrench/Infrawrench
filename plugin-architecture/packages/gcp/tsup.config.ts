import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ["@infrawrench/plugin-base"],
  },
  {
    entry: ["src/node-driver.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    external: ["@infrawrench/plugin-base"],
  },
]);
