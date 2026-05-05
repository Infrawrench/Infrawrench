import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import { PollerLoop } from "./loop";

async function main(): Promise<void> {
  const plugins = await loadPlugins();
  console.log(`[poller] loaded ${plugins.length} plugins`);

  const loop = new PollerLoop();
  loop.start();
  console.log("[poller] loop started (15s tick)");

  const shutdown = async (signal: string) => {
    console.log(`[poller] received ${signal}, draining...`);
    await loop.stop();
    console.log("[poller] shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("[poller] fatal:", e);
  process.exit(1);
});
