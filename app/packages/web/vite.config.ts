import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { vite as gtCompiler } from "@generaltranslation/compiler";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import gtConfig from "./gt.config.json" with { type: "json" };

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * The GT compiler's own include filter is extension-only, so it also parses
 * node_modules dists, where its build checks reject third-party patterns
 * (e.g. @tanstack/react-router). Scope it to this app's sources; the
 * @infrawrench/ui components are consumed as built dist and resolve their
 * translations through gt-react's runtime hashing instead.
 *
 * devHotReload (live dev translation) must also be forced off for builds:
 * it injects a top-level `await` into every module that translates strings,
 * which the production browser targets reject.
 */
function scopedGtCompiler(dev: boolean) {
  const srcRoot = resolve(__dirname, "src");
  const plugins = [gtCompiler({ gtConfig, ...(dev ? {} : { devHotReload: false }) })].flat();
  for (const plugin of plugins) {
    const p = plugin as { transformInclude?: (id: string) => boolean };
    const base = p.transformInclude;
    p.transformInclude = (id: string) => id.startsWith(srcRoot) && (base ? base(id) : true);
  }
  return plugins;
}

export default defineConfig(({ command }) => ({
  plugins: [
    TanStackRouterVite({
      routesDirectory: resolve(__dirname, "src/routes"),
      generatedRouteTree: resolve(__dirname, "src/routeTree.gen.ts"),
    }),
    tailwindcss(),
    react(),
    scopedGtCompiler(command === "serve"),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist/client",
  },
}));
