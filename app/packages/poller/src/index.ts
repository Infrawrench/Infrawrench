import { hostname } from "node:os";
import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import { PollerLoop, DEFAULT_TICK_MS, DEFAULT_CONCURRENCY } from "./loop";

/** Parse a positive-integer env var, falling back when unset or invalid. */
function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const plugins = await loadPlugins();
  console.log(`[poller] loaded ${plugins.length} plugins`);

  const tickMs = envInt("POLLER_TICK_MS", DEFAULT_TICK_MS);
  const concurrency = envInt("POLLER_CONCURRENCY", DEFAULT_CONCURRENCY);

  const loop = new PollerLoop({ tickMs, concurrency });
  loop.start();
  console.log(
    `[poller] loop started (tick ${tickMs}ms, concurrency ${concurrency}, instance ${hostname()}#${process.pid})`,
  );

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
