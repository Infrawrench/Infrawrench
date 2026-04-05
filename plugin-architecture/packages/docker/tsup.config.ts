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
    entry: ["src/driver.ts"],
    format: ["cjs"],
    dts: true,
    sourcemap: true,
    external: ["@infrawrench/plugin-base", "dockerode"],
  },
]);
