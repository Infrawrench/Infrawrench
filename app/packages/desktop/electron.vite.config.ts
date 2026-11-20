import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { vite as gtCompiler } from "@generaltranslation/compiler";
import gtConfig from "./gt.config.json" with { type: "json" };
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { rendererCspMetaTag } from "./electron/renderer-csp";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Inject the renderer's Content-Security-Policy (electron/renderer-csp.ts)
 * into the built index.html. Build-only: the Vite dev server's inline
 * React-refresh preamble and HMR client need inline script and eval.
 */
function rendererCsp(): Plugin {
  return {
    name: "renderer-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => {
        // The policy forbids inline script, so a build that emits one would
        // ship a blank window. Fail the build instead.
        if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
          throw new Error("index.html contains an inline <script>, which the renderer CSP blocks");
        }
        // Before any <script> or <link> so it governs them; after the charset,
        // which must stay first.
        const tag = rendererCspMetaTag();
        return /<meta charset[^>]*>/i.test(html)
          ? html.replace(/(<meta charset[^>]*>)/i, `$1\n    ${tag}`)
          : html.replace(/<head>/i, `<head>\n    ${tag}`);
      },
    },
  };
}

/**
 * The GT compiler's own include filter is extension-only, so it also parses
 * node_modules dists, where its build checks reject third-party patterns
 * (e.g. @tanstack/react-router). Scope it to the renderer's sources; the
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
 * The workflow sandbox bundles `@jitl/quickjs-ng-wasmfile-release-asyncify`
 * (the "wasmfile" QuickJS variant) into the main process. Its emscripten
 * loader reads `emscripten-module.wasm` from disk next to the emitted chunk
 * (`__dirname + "/emscripten-module.wasm"`), but Rollup doesn't copy that
 * binary asset. Emit it into the main build's `chunks/` dir so the loader
 * finds it at runtime. Resolved from the workflow-runtime package, which
 * declares the variant as a direct dependency.
 */
function copyQuickJsWasm(): Plugin {
  return {
    name: "copy-quickjs-wasm",
    generateBundle() {
      const require = createRequire(resolve(__dirname, "../workflow-runtime/package.json"));
      const wasmPath = require.resolve("@jitl/quickjs-ng-wasmfile-release-asyncify/wasm");
      this.emitFile({
        type: "asset",
        fileName: "chunks/emscripten-module.wasm",
        source: readFileSync(wasmPath),
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  main: {
    // Externalizes exactly the keys of package.json `dependencies`, which
    // electron-builder copies into the asar along with their whole dependency
    // trees. Everything else the main process imports (every workspace
    // package, `effect`, the Kubernetes client) is a devDependency and gets
    // bundled; listing one under `dependencies` either ships its tree for
    // nothing or, for a workspace package, throws "Cannot find module" at
    // startup. `electron/__tests__/bundled-workspace-deps.test.ts` holds both.
    plugins: [externalizeDepsPlugin(), copyQuickJsWasm()],
    // electron-vite leaves the main process unminified; minifying it roughly
    // halves the bundle. Names stay, so stack traces in logs and anything
    // that reads `constructor.name` keep working.
    esbuild: { keepNames: true },
    build: {
      minify: "esbuild",
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/preload.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "."),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "index.html") },
      },
    },
    plugins: [
      TanStackRouterVite({
        routesDirectory: resolve(__dirname, "src/routes"),
        generatedRouteTree: resolve(__dirname, "src/routeTree.gen.ts"),
      }),
      tailwindcss(),
      react(),
      rendererCsp(),
      scopedGtCompiler(command === "serve"),
      // `@netlify/api/lib/open_api.js` uses `createRequire` to load the
      // OpenAPI JSON spec, which fails in the renderer build because
      // `node:module` isn't available. Rewrite that one file to import the
      // JSON directly: Vite resolves JSON imports natively.
      {
        name: "netlify-open-api-shim",
        enforce: "pre",
        transform(_code, id) {
          if (id.endsWith("/@netlify/api/lib/open_api.js")) {
            return {
              code:
                'import spec from "@netlify/open-api/dist/swagger.json";\n' +
                "export const openApiSpec = spec;\n",
              map: null,
            };
          }
          return null;
        },
      },
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        // `@netlify/api` (and any other Node-only dep we transitively pull in)
        // imports `node-fetch`, which in v3 reaches into `node:util` and fails
        // the renderer's browser build. Map it to a shim over the platform
        // `fetch`; the renderer runs in Chromium and has a global fetch.
        "node-fetch": resolve(__dirname, "src/lib/node-fetch-shim.ts"),
      },
    },
  },
}));
