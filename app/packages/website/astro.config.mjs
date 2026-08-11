import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

import tailwindcss from "@tailwindcss/vite";

import remarkDocs from "./src/lib/remark-docs.mjs";
import rehypeTableScope from "./src/lib/rehype-table-scope.mjs";

export default defineConfig({
  site: "https://infrawrench.com",

  output: "server",

  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),

  markdown: {
    remarkPlugins: [remarkDocs],
    rehypePlugins: [rehypeTableScope],
    shikiConfig: { theme: "github-dark-default" },
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
