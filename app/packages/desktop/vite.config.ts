import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";

export default defineConfig({
  plugins: [
    TanStackRouterVite({ routesDirectory: "src/routes", generatedRouteTree: "src/routeTree.gen.ts" }),
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@blessed-plugins": path.resolve(__dirname, "../web/src/plugins/blessed-plugins.json"),
    },
  },
  // Prevent Vite from obscuring Rust panics
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS/Linux
    target: process.env["TAURI_PLATFORM"] === "windows" ? "chrome105" : "safari16",
    minify: process.env["TAURI_DEBUG"] ? false : "esbuild",
    sourcemap: !!process.env["TAURI_DEBUG"],
  },
});
