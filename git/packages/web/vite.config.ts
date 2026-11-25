import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

// The worker serves the built `dist/` as static assets and owns `/api` and
// the git transports; in development Vite proxies those to `wrangler dev`.
// With `VITE_GIT_MOCK=1` the API never leaves the browser (`src/mock`).
export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5174,
    proxy: { "/api": "http://127.0.0.1:8787", "/auth": "http://127.0.0.1:8787" },
  },
  // Each Shiki grammar is its own lazy chunk, and the largest (C++) is about 800 kB.
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
