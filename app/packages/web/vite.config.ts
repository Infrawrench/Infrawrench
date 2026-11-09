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
        // By the module it holds, not `facadeModuleId`: the lazily loaded
        // panels import code they share with the app from this chunk, and a
        // chunk that exports more than its entry module's own exports gets no
        // facade.
        const app = chunks.find((c) => c.moduleIds.some((id) => id.endsWith("/src/main.tsx")));
        if (!app) throw new Error("preloadAppChunk: no chunk for src/main.tsx");
        const entry = chunks.find((c) => c.isEntry);
        // Vite already preloads the entry and whatever it imports statically.
        const preloaded = new Set([entry?.fileName, ...(entry?.imports ?? [])]);
        const scripts = [app.fileName, ...app.imports.filter((f) => !preloaded.has(f))];
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

/**
 * Libraries every first load needs, in chunks of their own so a deploy does
 * not make returning visitors download them again.
 *
 * Inside the app chunk they were renamed with it on every deploy (its hash
 * covers all of its bytes), so each release re-sent React, recharts and the
 * rest. A chunk's hash also covers the names of the chunks it imports, so
 * these hold only libraries, which import only each other: React moves out of
 * the entry chunk for that reason (the entry names the app chunk, which
 * changes every deploy).
 *
 * An allowlist, never "everything in node_modules": a library only a lazily
 * loaded panel uses (xterm, the markdown renderer, Monaco) would be pulled out
 * of that panel's chunk into one the page loads up front. List only what the
 * app chunk already contains.
 */
const VENDOR_CHUNKS: ReadonlyArray<readonly [chunk: string, packages: RegExp]> = [
  ["vendor-react", /^(react|react-dom|scheduler|react-is|use-sync-external-store)$/],
  [
    "vendor-charts",
    /^(recharts|victory-vendor|d3-(array|color|format|interpolate|path|scale|shape|time|time-format)|internmap|decimal\.js-light|@reduxjs\/toolkit|redux|react-redux|reselect|immer|es-toolkit|eventemitter3|tiny-invariant)$/,
  ],
  ["vendor-effect", /^(effect|zod)$/],
  ["vendor-router", /^@tanstack\/(react-router|router-core|history|store|react-store)$/],
  ["vendor-i18n", /^(gt-react|gt-i18n|generaltranslation|@generaltranslation\/.+)$/],
];

function vendorChunk(id: string): string | undefined {
  const name = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id)?.[1];
  if (!name) return undefined;
  return VENDOR_CHUNKS.find(([, packages]) => packages.test(name))?.[0];
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
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
}));
