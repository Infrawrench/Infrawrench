import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

// The worker serves the built `dist/` as static assets and owns `/api` and
// the git transports; in development Vite proxies those to `wrangler dev`
// (git/README.md, "Local development").
// With `VITE_GIT_MOCK=1` the API never leaves the browser (`src/mock`).
/** `wrangler dev` (`node git/dev.mjs` starts both). */
const WORKER = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5174,
    proxy: {
      "/api": WORKER,
      "/auth": WORKER,
      // What the Worker's router calls the storage's routes (`http/router.ts`
      // `routeOf`): Git over HTTP, raw files, archives and the Terraform state
      // backend. Everything else under `/<owner>/<repo>` is a page of the UI.
      "^/[^/]+/[^/]+\\.git(/|$)": WORKER,
      "^/[^/]+/[^/]+/(raw|archive)/": WORKER,
      // Images from other sites (`images/proxy.ts`).
      "^/-/image(\\?|$)": WORKER,
      // Terraform writes and unlocks with a query (`state?ID=<lock>`), and Vite matches the URL with it.
      "^/[^/]+/[^/]+/terraform/[^/]+/state(/|\\?|$)": WORKER,
      // The MCP server, the authorization server its clients sign in through, and where
      // they find it (contract `urls.ts` `MCP_PATH`, `OAUTH_PATHS`, `WELL_KNOWN_PATHS`).
      // Patterns, not prefixes: `/mcp` as a prefix would also take a person called `mcpherson`.
      "^/mcp/?(\\?|$)": WORKER,
      "^/oauth/": WORKER,
      "^/\\.well-known/": WORKER,
    },
  },
  // Each Shiki grammar is its own lazy chunk, and the largest (C++) is about 800 kB.
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
