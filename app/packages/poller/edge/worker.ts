/**
 * The edge poller: the poller's work, on Cloudflare Workers.
 *
 * The Node poller (`src/index.ts`) runs one process that ticks every 15s and
 * does every pass in `src/passes.ts` in turn. Here the same passes run, split
 * three ways:
 *
 * - **`PollerScheduler`**, a single Durable Object, is the clock. Its alarm
 *   fires every `POLLER_TICK_MS` and does only cheap work: it runs each
 *   account pass's claim (scoped to `edge`, so accounts behind a bastion, an
 *   SSH tunnel or a socket driver stay with the Node gateway) and enqueues one
 *   message per claimed account, plus one per periodic edge pass that is due.
 * - **The queue consumer** does the work, one message per invocation, so a
 *   slow AWS account or a heavy cost backfill gets a Worker invocation (and
 *   its CPU and connection budget) to itself instead of holding up the tick.
 * - **The cron trigger** is a watchdog that re-arms the alarm, should it ever
 *   be lost; alarms persist, so in practice it is a no-op.
 *
 * Accounts whose work reaches a Node-only code path are handed to the gateway
 * by the passes themselves (`src/gateway-handoff.ts`); the Node poller runs
 * with `POLLER_SCOPE=gateway` alongside this Worker and picks them up.
 */
// The importable flavour of the Workers types: loading them as globals on top
// of Node's (which the server code is written against) clashes all over.
import type {
  DurableObjectNamespace,
  DurableObjectState,
  ExecutionContext,
  ExportedHandler,
  MessageBatch,
  Queue,
} from "@cloudflare/workers-types/index";
import {
  withEdgeInvocation,
  type EdgeBindings,
} from "@infrawrench/server-core/runtime/edge-invocation";
import { passesFor, findPass, type PassContext } from "../src/passes";
import type { PollAccountRow } from "../src/poll-account";
import { TokenBucketRegistry } from "../src/token-bucket";
import { DEFAULT_CONCURRENCY, DEFAULT_TICK_MS } from "../src/loop";

export interface Env extends EdgeBindings {
  POLL_QUEUE: Queue<PollMessage>;
  SCHEDULER: DurableObjectNamespace;
  POLLER_TICK_MS?: string;
  POLLER_CONCURRENCY?: string;
}

/** One unit of work: a periodic pass, or one account for an account pass. */
export interface PollMessage {
  pass: string;
  row?: PollAccountRow;
  /** Epoch ms the scheduler enqueued it; stale messages are dropped. */
  enqueuedAt: number;
}

/** A periodic pass message older than this is skipped; the next tick sends a fresh one. */
const PERIODIC_MESSAGE_TTL_MS = 60_000;
/** `Queue.sendBatch` accepts at most this many messages per call. */
const SEND_BATCH_MAX = 100;
const SCHEDULER_NAME = "poller";

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Per-isolate state, the edge's equivalent of the Node loop's fields. The
 * token buckets therefore throttle within an isolate rather than fleet-wide;
 * the per-account cadence, backoff and leases all live in Postgres and are
 * unaffected.
 */
let passContext: PassContext | null = null;
function getPassContext(env: Env): PassContext {
  passContext ??= {
    buckets: new TokenBucketRegistry(),
    concurrency: envInt(env.POLLER_CONCURRENCY, DEFAULT_CONCURRENCY),
  };
  return passContext;
}

/**
 * The clock. A plain Durable Object (no RPC): the cron watchdog pokes it with
 * a fetch, which arms the alarm if nothing is scheduled.
 */
export class PollerScheduler {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(): Promise<Response> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now());
    }
    return new Response("scheduled");
  }

  async alarm(): Promise<void> {
    // Re-arm first: a tick that throws must not stop the clock.
    const tickMs = envInt(this.env.POLLER_TICK_MS, DEFAULT_TICK_MS);
    await this.state.storage.setAlarm(Date.now() + tickMs);

    const messages = await withEdgeInvocation(this.env, this.state, () => this.collectMessages());
    for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
      await this.env.POLL_QUEUE.sendBatch(
        messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body, contentType: "json" })),
      );
    }
  }

  private async collectMessages(): Promise<PollMessage[]> {
    const now = Date.now();
    const ctx = getPassContext(this.env);
    const lastRunAt = (await this.state.storage.get<Record<string, number>>("lastRunAt")) ?? {};
    const messages: PollMessage[] = [];

    for (const pass of passesFor("edge")) {
      if (pass.kind === "accounts") {
        try {
          const rows = await pass.claim("edge", ctx);
          for (const row of rows) messages.push({ pass: pass.name, row, enqueuedAt: now });
        } catch (e) {
          console.error(pass.claimFailureLabel ?? "[poller-edge] resource claim failed:", e);
        }
        continue;
      }
      if (pass.minIntervalMs !== undefined) {
        const last = lastRunAt[pass.name];
        if (last !== undefined && now - last < pass.minIntervalMs) continue;
        lastRunAt[pass.name] = now;
      }
      messages.push({ pass: pass.name, enqueuedAt: now });
    }

    await this.state.storage.put("lastRunAt", lastRunAt);
    return messages;
  }
}

async function runMessage(body: PollMessage, env: Env): Promise<void> {
  const pass = findPass(body.pass);
  if (!pass) {
    console.warn(`[poller-edge] dropping message for unknown pass ${body.pass}`);
    return;
  }
  const age = Date.now() - body.enqueuedAt;
  if (pass.kind === "accounts") {
    if (!body.row) return;
    if (age > pass.leaseMs) {
      console.warn(
        `[poller-edge] ${pass.name} for ${body.row.id} arrived after its lease; skipped`,
      );
      return;
    }
    await pass.run(body.row, getPassContext(env));
    return;
  }
  // A periodic pass pinned to the gateway never reaches here unless the
  // registry changed between enqueue and delivery; the gateway runs it.
  if (pass.runtime !== "edge" || age > PERIODIC_MESSAGE_TTL_MS) return;
  await pass.run();
}

// No fetch handler: the Worker has no route, and nothing should reach it but
// its cron trigger and its queue.
const handler = {
  async scheduled(_controller, env: Env, ctx: ExecutionContext) {
    const scheduler = env.SCHEDULER.get(env.SCHEDULER.idFromName(SCHEDULER_NAME));
    ctx.waitUntil(scheduler.fetch("https://scheduler/ensure"));
  },

  async queue(batch: MessageBatch<PollMessage>, env: Env, ctx: ExecutionContext) {
    for (const message of batch.messages) {
      // Every pass logs and swallows its own failures, so a throw here means
      // the invocation itself broke; let the queue retry it once (see
      // wrangler.jsonc), the lease guards against working a row twice.
      await withEdgeInvocation(env, ctx, () => runMessage(message.body, env));
      message.ack();
    }
  },
} as ExportedHandler<Env, PollMessage>;

export default handler;
