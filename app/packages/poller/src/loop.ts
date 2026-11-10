import { TickLoop } from "@infrawrench/server-core/tick-loop";
import type { PollScope } from "@infrawrench/server-core/runtime/account-runtime";
import { passesFor, type AccountPass, type PassContext, type PeriodicPass } from "./passes";
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
 * One periodic pass on a loop of its own (`ownLoopMs`), beside the shared
 * tick: it never waits for the other passes, and they never wait for it.
 * One run at a time, the next `cadenceMs` after the last settles.
 */
export class OwnPassLoop extends TickLoop {
  constructor(private readonly pass: PeriodicPass & { ownLoopMs: number }) {
    super(`poller:${pass.name}`, pass.ownLoopMs);
  }

  get cadenceMs(): number {
    return this.pass.ownLoopMs;
  }

  protected runTick(): Promise<void> {
    return this.pass.run();
  }
}

/**
 * The Node poller: every tick, run each pass in `passes.ts` that belongs to
 * this process's scope, in order; a pass with `ownLoopMs` runs on its own
 * loop instead (`ownLoops`), started and stopped with this one.
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
  /** The passes that run on loops of their own, for this scope. */
  readonly ownLoops: readonly OwnPassLoop[];

  constructor(options: LoopOptions = {}) {
    super("poller", options.tickMs ?? DEFAULT_TICK_MS);
    this.scope = options.scope ?? "all";
    this.ctx = {
      buckets: new TokenBucketRegistry(),
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    };
    this.ownLoops = passesFor(this.scope)
      .filter(
        (p): p is PeriodicPass & { ownLoopMs: number } =>
          p.kind === "periodic" && p.ownLoopMs !== undefined,
      )
      .map((p) => new OwnPassLoop(p));
  }

  override start(): void {
    super.start();
    for (const loop of this.ownLoops) loop.start();
  }

  override async stop(): Promise<void> {
    await Promise.all([super.stop(), ...this.ownLoops.map((loop) => loop.stop())]);
  }

  protected async runTick(): Promise<void> {
    for (const pass of passesFor(this.scope)) {
      if (pass.kind === "accounts") {
        await this.runAccountPass(pass);
        continue;
      }
      if (pass.ownLoopMs !== undefined) continue;
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
