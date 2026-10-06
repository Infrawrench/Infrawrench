import { TickLoop } from "@infrawrench/server-core/tick-loop";
import type { PollScope } from "@infrawrench/server-core/runtime/account-runtime";
import { passesFor, type AccountPass, type PassContext } from "./passes";
import { TokenBucketRegistry } from "./token-bucket";

import { DEFAULT_CONCURRENCY, DEFAULT_TICK_MS } from "./defaults";

export { DEFAULT_CONCURRENCY, DEFAULT_TICK_MS };

interface LoopOptions {
  tickMs?: number;
  concurrency?: number;
  /** Which half of the edge/gateway split this process runs (`all` by default). */
  scope?: PollScope;
}

/**
 * The Node poller: every tick, run each pass in `passes.ts` that belongs to
 * this process's scope, in order.
 *
 * Each pass atomically claims its own batch (see `claim.ts`), so any number of
 * poller instances, Node or edge, can run concurrently against the same
 * database: scale out by adding replicas, no shard configuration.
 */
export class PollerLoop extends TickLoop {
  private readonly ctx: PassContext;
  private readonly scope: PollScope;
  /** Epoch ms each throttled pass last ran; absent means "run on the first tick". */
  private readonly lastRunAt = new Map<string, number>();

  constructor(options: LoopOptions = {}) {
    super("poller", options.tickMs ?? DEFAULT_TICK_MS);
    this.scope = options.scope ?? "all";
    this.ctx = {
      buckets: new TokenBucketRegistry(),
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    };
  }

  protected async runTick(): Promise<void> {
    for (const pass of passesFor(this.scope)) {
      if (pass.kind === "accounts") {
        await this.runAccountPass(pass);
        continue;
      }
      if (pass.minIntervalMs !== undefined) {
        const now = Date.now();
        const last = this.lastRunAt.get(pass.name);
        if (last !== undefined && now - last < pass.minIntervalMs) continue;
        this.lastRunAt.set(pass.name, now);
      }
      await pass.run();
    }
  }

  private async runAccountPass(pass: AccountPass): Promise<void> {
    let claimed;
    try {
      claimed = await pass.claim(this.scope, this.ctx);
    } catch (e) {
      if (!pass.claimFailureLabel) throw e;
      console.error(pass.claimFailureLabel, e);
      return;
    }
    if (claimed.length === 0) return;
    await Promise.allSettled(claimed.map((row) => pass.run(row, this.ctx)));
  }
}
