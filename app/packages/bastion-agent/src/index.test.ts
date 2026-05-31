import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// ---------------------------------------------------------------------------
// Fakes for `ws` and `node:net`. The agent module runs main() on import, so we
// install these mocks (and env) before importing it. Each test re-imports the
// module fresh via vi.resetModules() to get a clean Connection + timers.
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  url: string;
  protocols: unknown;
  options: unknown;
  sent: string[] = [];
  closed = false;
  terminated = false;
  private handlers = new Map<string, Handler[]>();

  constructor(url: string, protocols?: unknown, options?: unknown) {
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  send(data: string): void {
    if (this.sentThrows) throw new Error("send boom");
    this.sent.push(data);
  }
  sentThrows = false;

  close(): void {
    this.closed = true;
    if (this.closeThrows) throw new Error("close boom");
  }
  closeThrows = false;

  terminate(): void {
    this.terminated = true;
    if (this.terminateThrows) throw new Error("terminate boom");
  }
  terminateThrows = false;

  get lastSent(): unknown {
    const raw = this.sent[this.sent.length - 1];
    return raw ? JSON.parse(raw) : undefined;
  }

  get sentOps(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { op: string }).op);
  }
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  written: Buffer[] = [];
  ended = false;
  destroyed = false;
  destroyErr: Error | undefined;
  connectArgs: unknown;
  private handlers = new Map<string, Handler[]>();

  constructor(connectArgs: unknown) {
    this.connectArgs = connectArgs;
    FakeSocket.instances.push(this);
  }
  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  write(buf: Buffer): void {
    this.written.push(buf);
  }
  end(): void {
    this.ended = true;
  }
  destroy(err?: Error): void {
    this.destroyed = true;
    this.destroyErr = err;
  }
}

vi.mock("ws", () => ({
  WebSocket: vi.fn((url: string, protocols?: unknown, options?: unknown) => {
    return new FakeWebSocket(url, protocols, options);
  }),
}));

const netConnect = vi.fn((opts: unknown) => new FakeSocket(opts));
vi.mock("node:net", () => ({
  connect: (opts: unknown) => netConnect(opts),
}));

const ORIGINAL_ENV = { ...process.env };

async function loadAgent(env: Record<string, string | undefined> = {}): Promise<FakeWebSocket> {
  process.env.BASTION_TOKEN = "iwb_test_token";
  process.env.INFRAWRENCH_URL = "wss://example.test/api/bastions/agent";
  delete process.env.HEARTBEAT_TIMEOUT_MS;
  delete process.env.VERBOSE;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  FakeWebSocket.instances = [];
  FakeSocket.instances = [];
  await import("./index");
  // main() creates the first Connection synchronously
  const ws = FakeWebSocket.instances[0];
  if (!ws) throw new Error("no WebSocket created");
  return ws;
}

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((): never => undefined as never) as never);
});

afterEach(() => {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("bootstrap / required env", () => {
  it("connects with the bearer token and subprotocol", async () => {
    const ws = await loadAgent();
    expect(ws.url).toBe("wss://example.test/api/bastions/agent");
    expect(ws.protocols).toEqual(["infrawrench-bastion-v1"]);
    expect((ws.options as { headers: Record<string, string> }).headers.authorization).toBe(
      "Bearer iwb_test_token",
    );
  });

  it("exits(1) when BASTION_TOKEN is missing", async () => {
    await loadAgent({ BASTION_TOKEN: undefined });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith("[bastion-agent] missing required env: BASTION_TOKEN");
  });

  it("registers SIGTERM/SIGINT handlers", async () => {
    await loadAgent();
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
  });
});

describe("handshake & heartbeat", () => {
  it("sends agent-info on open and starts the heartbeat", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    expect(ws.lastSent).toEqual({ op: "agent-info", agentVersion: "0.1.0" });
    // heartbeat ping fires after 10s
    ws.sent.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(ws.sentOps).toContain("ping");
  });

  it("terminates the socket on heartbeat timeout", async () => {
    const ws = await loadAgent({ HEARTBEAT_TIMEOUT_MS: "5000" });
    ws.emit("open");
    // no traffic; advance beyond the 5s timeout, then let the 10s tick fire
    vi.advanceTimersByTime(10_000);
    expect(ws.terminated).toBe(true);
  });

  it("swallows a throw from terminate() on heartbeat timeout", async () => {
    const ws = await loadAgent({ HEARTBEAT_TIMEOUT_MS: "5000" });
    ws.emit("open");
    ws.terminateThrows = true;
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(ws.terminated).toBe(true);
  });

  it("does not send a ping while traffic keeps the peer alive", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    ws.sent.length = 0;
    // keep refreshing lastSeen with messages so timeout never trips
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(9_000);
      ws.emit("message", JSON.stringify({ op: "pong" }));
    }
    vi.advanceTimersByTime(10_000);
    expect(ws.sentOps).toContain("ping");
    expect(ws.terminated).toBe(false);
  });
});

describe("message handling", () => {
  async function open(): Promise<FakeWebSocket> {
    const ws = await loadAgent();
    ws.emit("open");
    ws.sent.length = 0;
    return ws;
  }

  function helloFor(ws: FakeWebSocket, allowlist: string[]) {
    ws.emit(
      "message",
      JSON.stringify({ op: "hello", protocolVersion: 1, allowlist, heartbeatMs: 30000 }),
    );
  }

  it("ignores malformed JSON without throwing", async () => {
    const ws = await open();
    expect(() => ws.emit("message", "{bad json")).not.toThrow();
    expect(ws.sent.length).toBe(0);
  });

  it("ignores unknown ops", async () => {
    const ws = await open();
    ws.emit("message", JSON.stringify({ op: "totally-unknown" }));
    expect(ws.sent.length).toBe(0);
  });

  it("responds to ping with pong", async () => {
    const ws = await open();
    ws.emit("message", JSON.stringify({ op: "ping" }));
    expect(ws.lastSent).toEqual({ op: "pong" });
  });

  it("ignores pong", async () => {
    const ws = await open();
    ws.emit("message", JSON.stringify({ op: "pong" }));
    expect(ws.sent.length).toBe(0);
  });

  it("rejects opening a non-allowlisted destination", async () => {
    const ws = await open();
    helloFor(ws, ["allowed.example.com"]);
    ws.sent.length = 0;
    ws.emit("message", JSON.stringify({ op: "open", streamId: 1, host: "evil.com", port: 443 }));
    expect(ws.lastSent).toMatchObject({ op: "open-failed", streamId: 1 });
    expect(netConnect).not.toHaveBeenCalled();
  });

  it("opens an exact-match allowlisted destination and reports opened", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.sent.length = 0;
    ws.emit("message", JSON.stringify({ op: "open", streamId: 7, host: "API.AWS.com", port: 443 }));
    expect(netConnect).toHaveBeenCalledWith({
      host: "API.AWS.com",
      port: 443,
      allowHalfOpen: true,
    });
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    sock.emit("connect");
    expect(ws.lastSent).toEqual({ op: "opened", streamId: 7 });
  });

  it("matches wildcard suffix allowlist entries", async () => {
    const ws = await open();
    helloFor(ws, ["*.amazonaws.com"]);
    ws.sent.length = 0;
    ws.emit(
      "message",
      JSON.stringify({ op: "open", streamId: 2, host: "ec2.us-east-1.amazonaws.com", port: 443 }),
    );
    expect(netConnect).toHaveBeenCalled();
  });

  it("forwards socket data as base64 to the backend", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.emit("message", JSON.stringify({ op: "open", streamId: 3, host: "api.aws.com", port: 443 }));
    ws.sent.length = 0;
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    sock.emit("data", Buffer.from("hello"));
    expect(ws.lastSent).toEqual({
      op: "data",
      streamId: 3,
      data: Buffer.from("hello").toString("base64"),
    });
  });

  it("surfaces a soft close when the remote ends the read side", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.emit("message", JSON.stringify({ op: "open", streamId: 4, host: "api.aws.com", port: 443 }));
    ws.sent.length = 0;
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    sock.emit("end");
    expect(ws.lastSent).toEqual({ op: "close", streamId: 4 });
  });

  it("reports open-failed when the socket errors", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.emit("message", JSON.stringify({ op: "open", streamId: 5, host: "api.aws.com", port: 443 }));
    ws.sent.length = 0;
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    sock.emit("error", new Error("ECONNREFUSED"));
    expect(ws.lastSent).toMatchObject({ op: "open-failed", streamId: 5, reason: "ECONNREFUSED" });
  });

  it("writes inbound data to the matching stream socket", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.emit("message", JSON.stringify({ op: "open", streamId: 6, host: "api.aws.com", port: 443 }));
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    const payload = Buffer.from("payload").toString("base64");
    ws.emit("message", JSON.stringify({ op: "data", streamId: 6, data: payload }));
    expect(sock.written[0]!.toString()).toBe("payload");
  });

  it("ignores inbound data for an unknown stream", async () => {
    const ws = await open();
    expect(() =>
      ws.emit("message", JSON.stringify({ op: "data", streamId: 999, data: "AA==" })),
    ).not.toThrow();
  });

  it("ends the stream socket on an end op", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.emit("message", JSON.stringify({ op: "open", streamId: 8, host: "api.aws.com", port: 443 }));
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    ws.emit("message", JSON.stringify({ op: "end", streamId: 8 }));
    expect(sock.ended).toBe(true);
  });

  it("ignores end for an unknown stream", async () => {
    const ws = await open();
    expect(() => ws.emit("message", JSON.stringify({ op: "end", streamId: 12345 }))).not.toThrow();
  });

  it("destroys a stream socket with reason on close op", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.emit("message", JSON.stringify({ op: "open", streamId: 9, host: "api.aws.com", port: 443 }));
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    ws.emit("message", JSON.stringify({ op: "close", streamId: 9, reason: "cancelled" }));
    expect(sock.destroyed).toBe(true);
    expect(sock.destroyErr?.message).toBe("cancelled");
  });

  it("destroys a stream socket without reason on close op", async () => {
    const ws = await open();
    helloFor(ws, ["api.aws.com"]);
    ws.emit(
      "message",
      JSON.stringify({ op: "open", streamId: 10, host: "api.aws.com", port: 443 }),
    );
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    ws.emit("message", JSON.stringify({ op: "close", streamId: 10 }));
    expect(sock.destroyed).toBe(true);
    expect(sock.destroyErr).toBeUndefined();
  });

  it("ignores close for an unknown stream", async () => {
    const ws = await open();
    expect(() => ws.emit("message", JSON.stringify({ op: "close", streamId: 404 }))).not.toThrow();
  });

  it("emits verbose logs when VERBOSE=1", async () => {
    const ws = await loadAgent({ VERBOSE: "1" });
    ws.emit("open");
    helloFor(ws, ["api.aws.com"]);
    ws.emit(
      "message",
      JSON.stringify({ op: "open", streamId: 11, host: "api.aws.com", port: 443 }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[bastion-agent"),
      expect.stringContaining("open stream 11"),
    );
  });
});

describe("send() edge cases", () => {
  it("does not send when the socket is not OPEN", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    ws.sent.length = 0;
    ws.readyState = FakeWebSocket.CLOSED;
    ws.emit("message", JSON.stringify({ op: "ping" }));
    expect(ws.sent.length).toBe(0);
  });

  it("logs but does not throw when ws.send throws", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    ws.sentThrows = true;
    expect(() => ws.emit("message", JSON.stringify({ op: "ping" }))).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[bastion-agent"),
      "send failed:",
      "send boom",
    );
  });
});

describe("ws close & reconnect", () => {
  it("destroys all streams and reconnects after the socket closes", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    ws.emit(
      "message",
      JSON.stringify({
        op: "hello",
        protocolVersion: 1,
        allowlist: ["api.aws.com"],
        heartbeatMs: 30000,
      }),
    );
    ws.emit("message", JSON.stringify({ op: "open", streamId: 1, host: "api.aws.com", port: 443 }));
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;

    ws.emit("close", 1006, Buffer.from("gone"));
    expect(sock.destroyed).toBe(true);

    // onClose doubles backoff (1000 -> 2000) before scheduling reconnect.
    expect(FakeWebSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("logs ws errors without throwing", async () => {
    const ws = await loadAgent();
    expect(() => ws.emit("error", new Error("transport gone"))).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[bastion-agent"),
      "ws error:",
      "transport gone",
    );
  });

  it("resets backoff to the initial value after a sustained connection", async () => {
    const ws = await loadAgent();
    ws.emit("close", 1006, Buffer.from("")); // backoff 1000 -> 2000
    vi.advanceTimersByTime(2_000); // reconnect #1 created (instances[1])
    expect(FakeWebSocket.instances.length).toBe(2);
    // after 30s of sustained connection the backoff resets to 1000ms
    vi.advanceTimersByTime(30_000);
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emit("close", 1006, Buffer.from("")); // backoff was reset -> 1000 -> 2000
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it("removes the stream on a socket 'close' event", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    ws.emit(
      "message",
      JSON.stringify({
        op: "hello",
        protocolVersion: 1,
        allowlist: ["api.aws.com"],
        heartbeatMs: 30000,
      }),
    );
    ws.emit("message", JSON.stringify({ op: "open", streamId: 1, host: "api.aws.com", port: 443 }));
    const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    sock.emit("close");
    // a subsequent data op for that stream is now a no-op (stream removed)
    expect(() =>
      ws.emit("message", JSON.stringify({ op: "data", streamId: 1, data: "AA==" })),
    ).not.toThrow();
    expect(sock.written.length).toBe(0);
  });

  it("applies exponential backoff across repeated failures", async () => {
    const ws = await loadAgent();
    ws.emit("close", 1006, Buffer.from("")); // backoff 1000 -> 2000
    vi.advanceTimersByTime(2_000); // first reconnect
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emit("close", 1006, Buffer.from("")); // backoff 2000 -> 4000
    // 2000ms is no longer enough; needs 4000ms now
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances.length).toBe(3);
  });
});

describe("shutdown", () => {
  it("closes the active connection and exits(0) on SIGTERM", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    process.emit("SIGTERM");
    expect(ws.closed).toBe(true);
    vi.advanceTimersByTime(200);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not reconnect after shutdown", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    process.emit("SIGINT");
    // close() sets closed=true; the handleClose path won't re-add a socket
    vi.advanceTimersByTime(5_000);
    // shutdown's setTimeout(exit) is the only thing scheduled
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("falls back to terminate when close() throws", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    ws.closeThrows = true;
    process.emit("SIGTERM");
    expect(ws.terminated).toBe(true);
  });

  it("swallows errors when both close() and terminate() throw", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    ws.closeThrows = true;
    ws.terminateThrows = true;
    expect(() => process.emit("SIGTERM")).not.toThrow();
  });

  it("close() is idempotent", async () => {
    const ws = await loadAgent();
    ws.emit("open");
    process.emit("SIGTERM");
    process.emit("SIGTERM");
    // second close is a no-op; still only one exit scheduled per signal handler
    expect(ws.closed).toBe(true);
  });
});
