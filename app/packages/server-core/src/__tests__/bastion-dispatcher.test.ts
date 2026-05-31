import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BastionAgentConnection wraps an undici Agent whose `connect` opens a Duplex
 * backed by a bastion WebSocket. We mock undici's Agent to capture the
 * `connect` option (so we can drive stream opens directly) and `destroy`. The
 * WS is a hand-rolled fake. `node:stream` Duplex is real.
 */

let capturedConnect:
  | ((
      opts: { hostname: string; port: string; protocol?: string },
      cb: (err: Error | null, sock: unknown) => void,
    ) => void)
  | undefined;
const agentDestroy = vi.fn(async () => undefined);
const AgentMock = vi.fn(function (this: unknown, opts: { connect: typeof capturedConnect }) {
  capturedConnect = opts.connect;
  return { destroy: agentDestroy };
});
vi.mock("undici", () => ({ Agent: AgentMock }));

let dispatcherMod: typeof import("../bastion/dispatcher");

interface FakeWs {
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  sent: () => unknown[];
}

function makeWs(over: Partial<FakeWs> = {}): FakeWs {
  const sentMsgs: unknown[] = [];
  const ws: FakeWs = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: vi.fn((s: string) => sentMsgs.push(JSON.parse(s))),
    sent: () => sentMsgs,
    ...over,
  };
  return ws;
}

beforeEach(async () => {
  vi.clearAllMocks();
  capturedConnect = undefined;
  vi.useRealTimers();
  dispatcherMod = await import("../bastion/dispatcher");
});

function newConn(ws: FakeWs) {
  return new dispatcherMod.BastionAgentConnection("bastion-1", ws as never);
}

describe("constructor / dispatcher", () => {
  it("creates an Agent and exposes it as the dispatcher", () => {
    const ws = makeWs();
    const conn = newConn(ws);
    expect(AgentMock).toHaveBeenCalledTimes(1);
    expect(conn.dispatcher).toBeDefined();
    expect(conn.bastionId).toBe("bastion-1");
  });
});

describe("allowlist", () => {
  it("splits exact hosts from wildcard suffixes and round-trips", () => {
    const conn = newConn(makeWs());
    conn.setAllowlist(["API.example.com", "*.amazonaws.com"]);
    const out = conn.currentAllowlist();
    expect(out).toContain("api.example.com");
    expect(out).toContain("*.amazonaws.com");
  });
});

describe("openStream via connect()", () => {
  function open(host: string, port = 443) {
    return new Promise<{ err: Error | null; sock: unknown }>((resolve) => {
      capturedConnect!({ hostname: host, port: String(port) }, (err, sock) =>
        resolve({ err, sock }),
      );
    });
  }

  it("rejects a destination that is not allowlisted", async () => {
    newConn(makeWs());
    const { err, sock } = await open("evil.example.com");
    expect(sock).toBeNull();
    expect(err?.message).toMatch(/not allowlisted/);
  });

  it("opens a stream and resolves once the agent confirms 'opened'", async () => {
    const ws = makeWs();
    const conn = newConn(ws);
    conn.setAllowlist(["api.example.com"]);
    const p = open("api.example.com");
    // The open message should have gone out on the WS.
    const openMsg = ws.sent().find((m) => (m as { op: string }).op === "open") as {
      op: string;
      streamId: number;
      host: string;
      port: number;
    };
    expect(openMsg).toBeTruthy();
    expect(openMsg.host).toBe("api.example.com");
    conn.handleMessage({ op: "opened", streamId: openMsg.streamId });
    const { err, sock } = await p;
    expect(err).toBeNull();
    expect(sock).toBeTruthy();
  });

  it("derives the default port from the protocol", async () => {
    const ws = makeWs();
    const conn = newConn(ws);
    conn.setAllowlist(["api.example.com"]);
    await new Promise<void>((resolve) => {
      capturedConnect!({ hostname: "api.example.com", port: "", protocol: "http:" }, () =>
        resolve(),
      );
      const openMsg = ws.sent().find((m) => (m as { op: string }).op === "open") as {
        port: number;
        streamId: number;
      };
      expect(openMsg.port).toBe(80);
      conn.handleMessage({ op: "opened", streamId: openMsg.streamId });
    });
  });

  it("rejects when the agent reports open-failed", async () => {
    const ws = makeWs();
    const conn = newConn(ws);
    conn.setAllowlist(["api.example.com"]);
    const p = open("api.example.com");
    const openMsg = ws.sent().find((m) => (m as { op: string }).op === "open") as {
      streamId: number;
    };
    conn.handleMessage({ op: "open-failed", streamId: openMsg.streamId, reason: "DNS fail" });
    const { err, sock } = await p;
    expect(sock).toBeNull();
    expect(err?.message).toMatch(/refused to open stream: DNS fail/);
  });

  it("rejects opens after the connection is destroyed", async () => {
    const conn = newConn(makeWs());
    conn.setAllowlist(["api.example.com"]);
    await conn.destroy();
    const { err } = await open("api.example.com");
    expect(err?.message).toMatch(/agent disconnected/);
  });
});

describe("handleMessage data/close on a live duplex", () => {
  async function openLiveStream() {
    const ws = makeWs();
    const conn = newConn(ws);
    conn.setAllowlist(["api.example.com"]);
    const sockP = new Promise<{ on: (e: string, h: (a?: unknown) => void) => unknown }>(
      (resolve) => {
        capturedConnect!({ hostname: "api.example.com", port: "443" }, (_err, sock) =>
          resolve(sock as never),
        );
      },
    );
    const openMsg = ws.sent().find((m) => (m as { op: string }).op === "open") as {
      streamId: number;
    };
    conn.handleMessage({ op: "opened", streamId: openMsg.streamId });
    const sock = await sockP;
    return { conn, ws, sock, streamId: openMsg.streamId };
  }

  it("pushes base64 data into the readable side of the duplex", async () => {
    const { conn, sock, streamId } = await openLiveStream();
    const chunks: Buffer[] = [];
    (sock as unknown as { on: (e: string, h: (c: Buffer) => void) => void }).on("data", (c) =>
      chunks.push(c),
    );
    conn.handleMessage({ op: "data", streamId, data: Buffer.from("hello").toString("base64") });
    await new Promise((r) => setTimeout(r, 0));
    expect(Buffer.concat(chunks).toString()).toBe("hello");
  });

  it("ends the readable side on a clean close", async () => {
    const { conn, sock, streamId } = await openLiveStream();
    let ended = false;
    (sock as unknown as { on: (e: string, h: () => void) => void }).on("end", () => {
      ended = true;
    });
    (sock as unknown as { resume: () => void }).resume();
    conn.handleMessage({ op: "close", streamId });
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).toBe(true);
  });

  it("destroys the duplex with an error when close carries a reason", async () => {
    const { conn, sock, streamId } = await openLiveStream();
    let errMsg: string | undefined;
    (sock as unknown as { on: (e: string, h: (e?: Error) => void) => void }).on("error", (e) => {
      errMsg = e?.message;
    });
    conn.handleMessage({ op: "close", streamId, reason: "peer reset" });
    await new Promise((r) => setTimeout(r, 0));
    expect(errMsg).toBe("peer reset");
  });

  it("ignores data/close/opened/open-failed for unknown streams", () => {
    const { conn } = { conn: newConn(makeWs()) };
    expect(() => conn.handleMessage({ op: "data", streamId: 999, data: "" })).not.toThrow();
    expect(() => conn.handleMessage({ op: "close", streamId: 999 })).not.toThrow();
    expect(() => conn.handleMessage({ op: "opened", streamId: 999 })).not.toThrow();
    expect(() =>
      conn.handleMessage({ op: "open-failed", streamId: 999, reason: "x" }),
    ).not.toThrow();
  });

  it("ignores unrelated control ops (ping/hello)", () => {
    const conn = newConn(makeWs());
    expect(() => conn.handleMessage({ op: "ping" })).not.toThrow();
    expect(() =>
      conn.handleMessage({ op: "hello", protocolVersion: 1, allowlist: [], heartbeatMs: 1 }),
    ).not.toThrow();
  });
});

describe("duplex write / final paths", () => {
  async function openLiveStream(ws: FakeWs) {
    const conn = newConn(ws);
    conn.setAllowlist(["api.example.com"]);
    const sockP = new Promise<unknown>((resolve) => {
      capturedConnect!({ hostname: "api.example.com", port: "443" }, (_e, s) => resolve(s));
    });
    const openMsg = ws.sent().find((m) => (m as { op: string }).op === "open") as {
      streamId: number;
    };
    conn.handleMessage({ op: "opened", streamId: openMsg.streamId });
    return { conn, sock: (await sockP) as { write: (b: Buffer) => void; end: () => void } };
  }

  it("sends a data frame for a normal write", async () => {
    const ws = makeWs();
    const { sock } = await openLiveStream(ws);
    sock.write(Buffer.from("xyz"));
    await new Promise((r) => setTimeout(r, 0));
    const dataMsg = ws.sent().find((m) => (m as { op: string }).op === "data") as {
      data: string;
    };
    expect(dataMsg).toBeTruthy();
    expect(Buffer.from(dataMsg.data, "base64").toString()).toBe("xyz");
  });

  it("sends an 'end' frame when the write side finishes", async () => {
    const ws = makeWs();
    const { sock } = await openLiveStream(ws);
    sock.end();
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.sent().some((m) => (m as { op: string }).op === "end")).toBe(true);
  });

  it("buffers writes under backpressure then flushes when the WS drains", async () => {
    const ws = makeWs({ bufferedAmount: 2 * 1024 * 1024 }); // above high watermark
    const { sock } = await openLiveStream(ws);
    const before = ws.sent().filter((m) => (m as { op: string }).op === "data").length;
    vi.useFakeTimers();
    sock.write(Buffer.from("delayed"));
    // Still buffered — nothing sent yet.
    expect(ws.sent().filter((m) => (m as { op: string }).op === "data").length).toBe(before);
    // Drain below low watermark and advance the polling interval.
    ws.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    expect(ws.sent().filter((m) => (m as { op: string }).op === "data").length).toBeGreaterThan(
      before,
    );
    vi.useRealTimers();
  });
});

describe("send() gating", () => {
  it("does not send when the WS is not OPEN", async () => {
    const ws = makeWs({ readyState: 0 });
    const conn = newConn(ws);
    conn.setAllowlist(["api.example.com"]);
    capturedConnect!({ hostname: "api.example.com", port: "443" }, () => undefined);
    // open() calls send() but readyState !== OPEN, so nothing is buffered.
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("destroy", () => {
  it("tears down streams, rejects pending opens, and destroys the agent", async () => {
    const ws = makeWs();
    const conn = newConn(ws);
    conn.setAllowlist(["api.example.com"]);
    const openP = new Promise<Error | null>((resolve) => {
      capturedConnect!({ hostname: "api.example.com", port: "443" }, (err) => resolve(err));
    });
    await conn.destroy(new Error("boom"));
    expect(agentDestroy).toHaveBeenCalled();
    const openErr = await openP;
    expect(openErr?.message).toBe("boom");
  });

  it("is idempotent", async () => {
    const conn = newConn(makeWs());
    await conn.destroy();
    await conn.destroy();
    expect(agentDestroy).toHaveBeenCalledTimes(1);
  });
});
