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

const __dirname = fileURLToPath(new URL(".", import.meta.url));

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
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@infrawrench/plugin-anthropic",
          "@infrawrench/plugin-assemblyai",
          "@infrawrench/plugin-cartesia",
          "@infrawrench/plugin-cohere",
          "@infrawrench/plugin-deepgram",
          "@infrawrench/plugin-deepseek",
          "@infrawrench/plugin-elevenlabs",
          "@infrawrench/plugin-fireworks",
          "@infrawrench/plugin-gemini",
          "@infrawrench/plugin-gladia",
          "@infrawrench/plugin-groq",
          "@infrawrench/plugin-mistral",
          "@infrawrench/plugin-openai",
          "@infrawrench/plugin-openrouter",
          "@infrawrench/plugin-replicate",
          "@infrawrench/plugin-revai",
          "@infrawrench/plugin-speechmatics",
          "@infrawrench/plugin-together",
          "@infrawrench/plugin-uploadthing",
          "@infrawrench/plugin-xai",
          "@infrawrench/plugin-workos",
          "@infrawrench/workflow-runtime",
          "@infrawrench/plugin-base",
          "@infrawrench/plugin-aws",
          "@infrawrench/plugin-azure",
          "@infrawrench/plugin-clickhouse",
          "@infrawrench/plugin-cloudflare",
          "@infrawrench/plugin-cloudinary",
          "@infrawrench/plugin-databricks",
          "@infrawrench/plugin-digitalocean",
          "@infrawrench/plugin-docker",
          "@infrawrench/plugin-fly",
          "@infrawrench/plugin-gcp",
          "@infrawrench/plugin-hetzner",
          "@infrawrench/plugin-kafka",
          "@infrawrench/plugin-kubernetes",
          "@infrawrench/plugin-memcached",
          "@infrawrench/plugin-mongodb",
          "@infrawrench/plugin-mysql",
          "@infrawrench/plugin-mssql",
          "@infrawrench/plugin-netlify",
          "@infrawrench/plugin-neon",
          "@infrawrench/plugin-opensearch",
          "@infrawrench/plugin-planetscale",
          "@infrawrench/plugin-postgres",
          "@infrawrench/plugin-redis",
          "@infrawrench/plugin-scaleway",
          "@infrawrench/plugin-ovh",
          "@infrawrench/plugin-ssh",
          "@infrawrench/plugin-turso",
          "@infrawrench/plugin-vercel",
          "@infrawrench/ui",
          // ESM-only, and the CLI's dependency-graph command imports it at
          // runtime. Bundling resolves the dynamic import into a chunk instead
          // of leaving a CJS main process to import an ESM package at runtime.
          "@infrawrench/client-core",
          // The Linux app server's host side, imported by `iwappd-host.ts` and
          // the `apps` CLI command. Every workspace package the main process
          // imports has to be bundled: electron-builder's `files` drops
          // `node_modules/@infrawrench/**` from the asar, so an externalized
          // one throws "Cannot find module" the moment the app starts — with
          // no window, just a lit dock icon.
          "@infrawrench/appstream-host",
          // The shared SSH agents and tunnel core, imported by `ssh-shell-agent.ts`,
          // `ssh-tunnel.ts`, `ssh-host-keys.ts` and `cloud-key-agent.ts`.
          "@infrawrench/ssh-tunnel-core",
        ],
      }),
      copyQuickJsWasm(),
    ],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/index.ts") },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@infrawrench/plugin-anthropic",
          "@infrawrench/plugin-assemblyai",
          "@infrawrench/plugin-base",
          "@infrawrench/plugin-aws",
          "@infrawrench/plugin-azure",
          "@infrawrench/plugin-cartesia",
          "@infrawrench/plugin-clickhouse",
          "@infrawrench/plugin-cloudflare",
          "@infrawrench/plugin-cloudinary",
          "@infrawrench/plugin-cohere",
          "@infrawrench/plugin-databricks",
          "@infrawrench/plugin-deepgram",
          "@infrawrench/plugin-deepseek",
          "@infrawrench/plugin-digitalocean",
          "@infrawrench/plugin-docker",
          "@infrawrench/plugin-elevenlabs",
          "@infrawrench/plugin-fireworks",
          "@infrawrench/plugin-fly",
          "@infrawrench/plugin-gcp",
          "@infrawrench/plugin-gemini",
          "@infrawrench/plugin-gladia",
          "@infrawrench/plugin-groq",
          "@infrawrench/plugin-hetzner",
          "@infrawrench/plugin-kafka",
          "@infrawrench/plugin-kubernetes",
          "@infrawrench/plugin-memcached",
          "@infrawrench/plugin-mistral",
          "@infrawrench/plugin-mongodb",
          "@infrawrench/plugin-mysql",
          "@infrawrench/plugin-mssql",
          "@infrawrench/plugin-netlify",
          "@infrawrench/plugin-neon",
          "@infrawrench/plugin-openai",
          "@infrawrench/plugin-openrouter",
          "@infrawrench/plugin-opensearch",
          "@infrawrench/plugin-planetscale",
          "@infrawrench/plugin-postgres",
          "@infrawrench/plugin-redis",
          "@infrawrench/plugin-replicate",
          "@infrawrench/plugin-revai",
          "@infrawrench/plugin-scaleway",
          "@infrawrench/plugin-ovh",
          "@infrawrench/plugin-speechmatics",
          "@infrawrench/plugin-ssh",
          "@infrawrench/plugin-together",
          "@infrawrench/plugin-turso",
          "@infrawrench/plugin-uploadthing",
          "@infrawrench/plugin-vercel",
          "@infrawrench/plugin-xai",
          "@infrawrench/plugin-workos",
          "@infrawrench/ui",
        ],
      }),
    ],
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
      scopedGtCompiler(command === "serve"),
      // `@netlify/api/lib/open_api.js` uses `createRequire` to load the
      // OpenAPI JSON spec, which fails in the renderer build because
      // `node:module` isn't available. Rewrite that one file to import the
      // JSON directly — Vite resolves JSON imports natively.
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
