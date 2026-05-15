/**
 * undici `Dispatcher` that opens TCP sockets through a connected bastion
 * agent rather than directly via `net.connect`. The dispatcher itself is
 * what gets handed to `undici.fetch({ dispatcher })` — TLS is still
 * negotiated client-side, so bytes the agent sees are already encrypted.
 *
 * Pitfalls baked in here (see plan.md):
 *   - Half-close: undici can end its write side before reading the response.
 *     Our duplex therefore honors `allowHalfOpen: true` and translates a
 *     `null`-end into a wire-level `{op:"end"}` to the agent.
 *   - Pooling: each WS lifecycle owns its own Agent. When the agent
 *     disconnects, the Agent is destroyed and undici evicts pooled sockets
 *     instead of trying to reuse a dead duplex.
 *   - Backpressure: WS frames don't carry TCP backpressure. We pause writes
 *     to undici when the WS's `bufferedAmount` crosses a threshold.
 *   - HTTP/2: not supported. Control-plane APIs accept HTTP/1.1.
 */

import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { Agent, type Dispatcher } from "undici";
import type { WebSocket as WsWebSocket } from "ws";
import { BastionStreamOpenError } from "./errors.js";
import type { BastionMessage } from "./protocol.js";

const WS_BUFFER_HIGH_WATERMARK = 1 * 1024 * 1024; // 1 MiB
const WS_BUFFER_LOW_WATERMARK = 256 * 1024; // 256 KiB

interface PendingOpen {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface ActiveStream {
  duplex: Duplex;
  /** Set once when the agent confirms the open succeeded. */
  opened: boolean;
}

/**
 * One `AgentConnection` per live bastion-agent WebSocket. Owns the stream
 * id allocator, the in-flight stream table, and the undici `Dispatcher`
 * plugins talk to.
 */
export class BastionAgentConnection {
  readonly bastionId: string;
  private readonly ws: WsWebSocket;
  private nextStreamId = 1;
  private readonly pendingOpens = new Map<number, PendingOpen>();
  private readonly streams = new Map<number, ActiveStream>();
  private readonly dispatcherInstance: Dispatcher;
  private destroyed = false;
  /** Hostnames allowed to be tunneled — mirrors what we told the agent. */
  private allowlist: Set<string> = new Set();
  /** Wildcard suffixes like `.amazonaws.com` (without the leading `*`). */
  private allowlistSuffixes: string[] = [];

  constructor(bastionId: string, ws: WsWebSocket) {
    this.bastionId = bastionId;
    this.ws = ws;
    this.dispatcherInstance = new Agent({
      // Custom connect: skip TCP entirely; hand undici a Duplex backed by the WS.
      // We synthesize a socket-shaped object — undici only needs `Duplex`-level
      // semantics plus a handful of `Socket` no-op methods that the Duplex
      // factory below stubs out.
      connect: (opts, cb) => {
        const host = opts.hostname;
        const port = Number(opts.port) || (opts.protocol === "http:" ? 80 : 443);
        this.openStream(host, port)
          .then((duplex) => cb(null, duplex as unknown as Socket))
          .catch((err) => cb(err as Error, null));
      },
      // Don't pool aggressively — each cloud-API call is fine opening a fresh stream.
      keepAliveTimeout: 1000,
      keepAliveMaxTimeout: 5000,
    });
  }

  get dispatcher(): Dispatcher {
    return this.dispatcherInstance;
  }

  /** Update the egress allowlist (called from the registry when accounts change). */
  setAllowlist(hosts: string[]): void {
    this.allowlist = new Set();
    this.allowlistSuffixes = [];
    for (const h of hosts) {
      if (h.startsWith("*.")) {
        this.allowlistSuffixes.push(h.slice(1)); // ".amazonaws.com"
      } else {
        this.allowlist.add(h.toLowerCase());
      }
    }
  }

  /** Allowlist getter — used to keep the agent in sync via the hello message. */
  currentAllowlist(): string[] {
    return [...this.allowlist, ...this.allowlistSuffixes.map((s) => `*${s}`)];
  }

  /** Dispatch a message arriving on the WS. */
  handleMessage(msg: BastionMessage): void {
    switch (msg.op) {
      case "opened": {
        const pending = this.pendingOpens.get(msg.streamId);
        if (!pending) return;
        this.pendingOpens.delete(msg.streamId);
        const stream = this.streams.get(msg.streamId);
        if (stream) stream.opened = true;
        pending.resolve();
        return;
      }
      case "open-failed": {
        const pending = this.pendingOpens.get(msg.streamId);
        this.pendingOpens.delete(msg.streamId);
        this.streams.delete(msg.streamId);
        pending?.reject(new BastionStreamOpenError(this.bastionId, msg.reason));
        return;
      }
      case "data": {
        const stream = this.streams.get(msg.streamId);
        if (!stream) return;
        const buf = Buffer.from(msg.data, "base64");
        // Push into the readable side of the duplex.
        stream.duplex.push(buf);
        return;
      }
      case "close": {
        const stream = this.streams.get(msg.streamId);
        if (!stream) return;
        this.streams.delete(msg.streamId);
        stream.duplex.push(null);
        if (msg.reason) stream.duplex.destroy(new Error(msg.reason));
        return;
      }
      // Hello/ping/pong/agent-info are handled at the registry/route layer.
      default:
        return;
    }
  }

  /** Open a new TCP stream through the agent. */
  private async openStream(host: string, port: number): Promise<Duplex> {
    if (this.destroyed) {
      throw new BastionStreamOpenError(this.bastionId, "agent disconnected");
    }
    if (!this.isAllowed(host)) {
      throw new BastionStreamOpenError(
        this.bastionId,
        `destination not allowlisted: ${host}:${port}`,
      );
    }
    const streamId = this.nextStreamId++;
    const duplex = this.buildDuplex(streamId);
    this.streams.set(streamId, { duplex, opened: false });
    const opened = new Promise<void>((resolve, reject) => {
      this.pendingOpens.set(streamId, { resolve, reject });
    });
    this.send({ op: "open", streamId, host, port });
    await opened;
    return duplex;
  }

  private buildDuplex(streamId: number): Duplex {
    const self = this;
    let paused = false;
    return new Duplex({
      allowHalfOpen: true,
      write(chunk: Buffer, _encoding, cb) {
        // Backpressure: pause writes once the WS buffer grows past the high water mark.
        if (self.ws.bufferedAmount > WS_BUFFER_HIGH_WATERMARK) {
          paused = true;
          const wait = setInterval(() => {
            if (self.ws.bufferedAmount < WS_BUFFER_LOW_WATERMARK) {
              clearInterval(wait);
              paused = false;
              self.send({ op: "data", streamId, data: chunk.toString("base64") });
              cb();
            }
          }, 50);
          return;
        }
        self.send({ op: "data", streamId, data: chunk.toString("base64") });
        cb();
      },
      final(cb) {
        // Write-side end → tell the agent we're done sending. The agent may
        // still send response bytes after this (TCP half-close).
        self.send({ op: "end", streamId });
        cb();
      },
      read() {
        /* Push happens from handleMessage("data") */
      },
      destroy(err, cb) {
        if (self.streams.has(streamId)) {
          self.streams.delete(streamId);
          self.send({ op: "close", streamId, ...(err ? { reason: err.message } : {}) });
        }
        cb(err);
      },
    }).on("error", () => {
      // Swallow — undici reports errors via the callback we returned from connect().
      void paused;
    });
  }

  private isAllowed(host: string): boolean {
    const lower = host.toLowerCase();
    if (this.allowlist.has(lower)) return true;
    for (const suffix of this.allowlistSuffixes) {
      if (lower.endsWith(suffix)) return true;
    }
    return false;
  }

  private send(msg: BastionMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Tear down the connection. Closes all in-flight streams. */
  async destroy(reason?: Error): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [, stream] of this.streams) {
      stream.duplex.destroy(reason ?? new Error("Bastion agent disconnected"));
    }
    this.streams.clear();
    for (const [, pending] of this.pendingOpens) {
      pending.reject(reason ?? new BastionStreamOpenError(this.bastionId, "agent disconnected"));
    }
    this.pendingOpens.clear();
    await this.dispatcherInstance.destroy();
  }
}
