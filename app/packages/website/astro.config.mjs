import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

import tailwindcss from "@tailwindcss/vite";

import remarkDocs from "./src/lib/remark-docs.mjs";

export default defineConfig({
  output: "server",

  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),

  markdown: {
    remarkPlugins: [remarkDocs],
    shikiConfig: { theme: "github-dark-default" },
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
