/**
 * The poller on AWS Lambda, in place of the Node poller Deployment.
 *
 * EventBridge Scheduler invokes this once a minute (`infra/terraform/lambda.tf`).
 * Each invocation runs the same `PollerLoop` the Node process does, with the
 * same `POLLER_SCOPE`, ticking on its usual cadence for most of the minute
 * (`lambda-window.ts`); with the edge poller Worker live that scope is
 * `gateway`, so this claims the accounts that need Node and runs the gateway
 * passes. Every claim is a row lease, so overlapping invocations, a leftover
 * Node poller and the edge Worker can all run at once.
 *
 * What does not carry over from a long-lived process, and why that is fine:
 *
 * - The loop (its token buckets, the in-memory `minIntervalMs` clock) lives as
 *   long as the execution environment, so a cold start resets them. The
 *   buckets only smooth bursts against providers; the per-account schedule,
 *   backoff and leases are all in Postgres. No gateway pass uses
 *   `minIntervalMs`; under `POLLER_SCOPE=all` the change-retention prune may
 *   run a little more often than hourly, which is harmless.
 * - Fire-and-forget work is awaited before the invocation ends
 *   (`lambdaInvocation().drain()`), so nothing is frozen mid-write.
 */
import { lambdaInvocation, prepareLambdaProcess } from "@infrawrench/server-core/runtime/lambda";
import { runTicksInWindow } from "./lambda-window";
import { DEFAULT_CONCURRENCY, DEFAULT_TICK_MS } from "./defaults";

/** Leave this much of the function's timeout unused by the tick window. */
const WINDOW_MARGIN_MS = 5_000;
/** EventBridge Scheduler's finest rate, and so how long one invocation should tick for. */
const SCHEDULE_PERIOD_MS = 60_000;

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

// Init phase: configuration, then the plugins and the pass registry, once per
// execution environment.
await prepareLambdaProcess();
const [{ loadPlugins }, { PollerLoop }, { parsePollScope }] = await Promise.all([
  import("@infrawrench/server-core/plugin-loader"),
  import("./loop"),
  import("@infrawrench/server-core/runtime/account-runtime"),
]);
const plugins = await loadPlugins();
const tickMs = envInt("POLLER_TICK_MS", DEFAULT_TICK_MS);
const scope = parsePollScope(process.env["POLLER_SCOPE"]);
const loop = new PollerLoop({
  tickMs,
  concurrency: envInt("POLLER_CONCURRENCY", DEFAULT_CONCURRENCY),
  scope,
});
console.log(`[poller-lambda] loaded ${plugins.length} plugins (tick ${tickMs}ms, scope ${scope})`);

export async function handler(_event: unknown, context: LambdaContext): Promise<{ ticks: number }> {
  const invocation = lambdaInvocation();
  // Tick for most of a minute: the next scheduled invocation takes over then.
  // A short function timeout shrinks the window rather than being overrun.
  const windowMs = Math.max(
    0,
    Math.min(SCHEDULE_PERIOD_MS - WINDOW_MARGIN_MS, context.getRemainingTimeInMillis() - tickMs),
  );
  const ticks = await invocation.run(() =>
    runTicksInWindow(() => loop.tick(), { tickMs, windowMs }),
  );
  await invocation.drain();
  return { ticks };
}
