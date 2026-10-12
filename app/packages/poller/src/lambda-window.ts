/**
 * How the Lambda poller (`lambda.ts`) fits the Node loop's 15-second cadence
 * into invocations that EventBridge Scheduler starts at most once a minute.
 *
 * Each invocation ticks on the loop's schedule (the next tick starts `tickMs`
 * after the previous one settles, never on a fixed interval) and stops
 * starting new ticks once the next one would begin past `windowMs`. An
 * overrunning tick is finished, not cut off; the next scheduled invocation
 * may then overlap it, which the claim leases make safe exactly as they do
 * for several Node replicas.
 */
export interface TickWindowOptions {
  tickMs: number;
  /** How long after the start a new tick may still begin. */
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `tick` repeatedly within the window; resolves with the number of ticks run. */
export async function runTicksInWindow(
  tick: () => Promise<void>,
  options: TickWindowOptions,
): Promise<number> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.windowMs;
  let ticks = 0;
  for (;;) {
    await tick();
    ticks++;
    if (now() + options.tickMs > deadline) return ticks;
    await sleep(options.tickMs);
  }
}
