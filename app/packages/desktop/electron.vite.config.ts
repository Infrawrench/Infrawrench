import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "electron/main.ts") },
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
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@blessed-plugins": resolve(__dirname, "../web/src/plugins/blessed-plugins.json"),
      },
    },
  },
});
