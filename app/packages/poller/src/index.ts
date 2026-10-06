import { hostname } from "node:os";
import { loadPlugins } from "@infrawrench/server-core/plugin-loader";
import { installShutdownHandlers, runService } from "@infrawrench/server-core/tick-loop";
import { parsePollScope } from "@infrawrench/server-core/runtime/account-runtime";
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
  // `gateway` once the edge poller Worker is live (see edge/worker.ts): this
  // process then claims only accounts that need Node and runs only the
  // gateway passes. Unset keeps the single-process behaviour.
  const scope = parsePollScope(process.env["POLLER_SCOPE"]);

  const loop = new PollerLoop({ tickMs, concurrency, scope });
  loop.start();
  console.log(
    `[poller] loop started (tick ${tickMs}ms, concurrency ${concurrency}, scope ${scope}, instance ${hostname()}#${process.pid})`,
  );

  installShutdownHandlers("poller", loop);
}

runService("poller", main);
