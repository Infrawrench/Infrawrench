import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { vite as gtCompiler } from "@generaltranslation/compiler";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import gtConfig from "./gt.config.json" with { type: "json" };
import { workersAssetHeadersFile } from "./src/api/security-headers";

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

/**
 * Write `dist/client/_headers`: the security headers and the hashed assets'
 * cache for the Workers asset layer, which serves the built files without
 * running the edge Worker (see `workersAssetHeadersFile`).
 */
function edgeAssetHeaders(): Plugin {
  return {
    name: "infrawrench:edge-asset-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: workersAssetHeadersFile() });
    },
  };
}

/**
 * Start downloading the app chunk (`src/main.tsx`) and its stylesheet with the
 * page instead of after the entry has run.
 *
 * `src/index.ts` imports `./main` only once gt-react has settled the locale
 * (and, for a translated locale, fetched its catalog), so without this the
 * browser learns about the largest chunk only after the entry chunk has
 * downloaded and run: one more round trip in series before anything renders.
 * `modulepreload` fetches and compiles without running, so the boot order is
 * unchanged; Vite's own preload helper skips the stylesheet once it is linked.
 */
function preloadAppChunk(): Plugin {
  return {
    name: "infrawrench:preload-app-chunk",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const chunks = Object.values(ctx.bundle ?? {}).filter((c) => c.type === "chunk");
        const app = chunks.find((c) => c.facadeModuleId?.endsWith("/src/main.tsx"));
        if (!app) throw new Error("preloadAppChunk: no chunk for src/main.tsx");
        const entry = chunks.find((c) => c.isEntry)?.fileName;
        const scripts = [app.fileName, ...app.imports.filter((f) => f !== entry)];
        const styles = [...(app.viteMetadata?.importedCss ?? [])];
        return [
          ...styles.map((href) => ({
            tag: "link",
            attrs: { rel: "stylesheet", crossorigin: true, href: `/${href}` },
            injectTo: "head" as const,
          })),
          ...scripts.map((href) => ({
            tag: "link",
            attrs: { rel: "modulepreload", crossorigin: true, href: `/${href}` },
            injectTo: "head" as const,
          })),
        ];
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    edgeAssetHeaders(),
    preloadAppChunk(),
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
