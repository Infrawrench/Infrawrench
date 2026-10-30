import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { workersCacheCdnAdapter } from "@vinext/cloudflare/cache/workers-cache-cdn-adapter";

export default defineConfig({
  plugins: [
    // Pages are ISR (`revalidate` on each route), served from Workers Cache:
    // the KV data only changes when the sync Action runs, twice an hour.
    vinext({ cache: { cdn: workersCacheCdnAdapter() } }),
    cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
  ],
});
