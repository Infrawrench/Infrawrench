import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: resolve(__dirname, "src/routes"),
      generatedRouteTree: resolve(__dirname, "src/routeTree.gen.ts"),
    }),
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist/client",
  },
});
