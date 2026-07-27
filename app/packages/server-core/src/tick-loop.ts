/**
 * The scheduling skeleton behind the two background services (`poller`,
 * `github-watcher`).
 *
 * Both had their own copy of it, and the copies were identical down to the
 * drain deadline — which matters, because the numbers here are load-bearing:
 * ticks are scheduled *after* the previous one settles (never on a fixed
 * interval, so a slow tick can't stack), a tick that overruns is skipped
 * rather than run concurrently, and `stop()` gives an in-flight tick 30s to
 * finish because Kubernetes' default `terminationGracePeriodSeconds` is 30.
 *
 * Subclasses supply only the work: everything about *when* it runs lives here.
 */
export abstract class TickLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private running = false;

  /**
   * @param name Log prefix, e.g. `poller`.
   * @param tickMs Delay between the end of one tick and the start of the next.
   */
  protected constructor(
    private readonly name: string,
    private readonly tickMs: number,
  ) {}

  /**
   * One pass of work. Throwing is safe — `tick()` logs and carries on to the
   * next interval — but a subclass that wants per-item resilience should
   * catch inside its own loop so one bad row can't skip the rest of the batch.
   */
  protected abstract runTick(): Promise<void>;

  /** Run a tick now, then keep ticking until `stop()`. Idempotent. */
  start(): void {
    if (this.timer) return;
    const scheduleNext = () => {
      if (this.stopping) return;
      this.timer = setTimeout(async () => {
        await this.tick();
        scheduleNext();
      }, this.tickMs);
    };
    // Fire first tick immediately, then schedule on interval.
    void this.tick().then(scheduleNext);
  }

  /** Stop scheduling and wait (bounded) for an in-flight tick to drain. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + 30_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Run one tick, unless one is already in flight. Public so tests can drive a
   * single pass without starting the timer.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runTick();
    } catch (e) {
      console.error(`[${this.name}] tick failed:`, e);
    } finally {
      this.running = false;
    }
  }
}

/**
 * Standard entrypoint for a background service: run `main`, drain the loop on
 * SIGTERM/SIGINT, and exit non-zero if startup throws.
 */
export function runService(name: string, main: () => Promise<void>): void {
  main().catch((e) => {
    console.error(`[${name}] fatal:`, e);
    process.exit(1);
  });
}

/** Drain `loop` and exit cleanly when the orchestrator asks us to stop. */
export function installShutdownHandlers(name: string, loop: { stop(): Promise<void> }): void {
  const shutdown = async (signal: string) => {
    console.log(`[${name}] received ${signal}, draining...`);
    await loop.stop();
    console.log(`[${name}] shutdown complete`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
