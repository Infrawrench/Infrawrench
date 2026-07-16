import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const sshClients: FakeSshClient[] = [];

class FakeSshClient extends EventEmitter {
  connectConfig: Record<string, unknown> | null = null;
  ended = false;
  shellCalled = false;
  shellCb: ((err: Error | undefined, stream: FakeShellStream) => void) | null = null;

  constructor() {
    super();
    sshClients.push(this);
  }

  connect(cfg: Record<string, unknown>) {
    this.connectConfig = cfg;
  }

  shell(_opts: unknown, cb: (err: Error | undefined, stream: FakeShellStream) => void) {
    this.shellCalled = true;
    this.shellCb = cb;
  }

  end() {
    this.ended = true;
    // Real ssh2 clients emit "close" when ended — the chain establishment
    // promise relies on this to settle after a concurrent teardown.
    this.emit("close");
  }
}

class FakeShellStream extends EventEmitter {
  stderr = Object.assign(new EventEmitter(), { pause: () => {}, resume: () => {} });
  ended = false;
  written: Buffer[] = [];
  pause() {}
  resume() {}
  write(data: Buffer) {
    this.written.push(data);
  }
  setWindow() {}
  end() {
    this.ended = true;
  }
}

// The source default-imports ssh2 (CJS interop), so mirror the module there.
vi.mock("ssh2", () => {
  const mod = { Client: FakeSshClient };
  return { ...mod, default: mod };
});

const mockSelect = vi.fn();
vi.mock("@/db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));

vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue("PRIVATE_KEY"),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

vi.mock("@/plugins/loader", () => ({ getPlugin: vi.fn() }));
vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/services/ssh-agent", () => ({ buildInProcessAgent: vi.fn().mockReturnValue(null) }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

class HostKeyTrustRequiredError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly kind: "unknown" | "mismatch",
    readonly presentedFingerprint: string,
    readonly storedFingerprint: string | null,
  ) {
    super(`host key ${kind} for ${host}:${port}`);
  }
}
const mockMakeHostKeyVerifier = vi.fn();
vi.mock("@/services/ssh-host-keys", () => ({
  HostKeyTrustRequiredError,
  makeHostKeyVerifier: (...a: unknown[]) => mockMakeHostKeyVerifier(...a),
}));

const mockResolveSshChain = vi.fn();
const mockForwardOutHop = vi.fn();
vi.mock("@infrawrench/plugin-ssh", () => ({
  resolveSshChain: (...a: unknown[]) => mockResolveSshChain(...a),
  forwardOutHop: (...a: unknown[]) => mockForwardOutHop(...a),
}));

const { handleSshSession } = await import("@/services/ssh-proxy");

const KEY_ROW = { id: "k1", encryptedPrivateKey: "enc", privateKeyIv: "iv" };

function selectRows(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

function fakeWs() {
  const emitter = new EventEmitter();
  const sent: Record<string, unknown>[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send: (msg: string) => sent.push(JSON.parse(msg) as Record<string, unknown>),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    close: () => {
      ws.readyState = 3;
      emitter.emit("close");
    },
  };
  return ws;
}

const DIRECT = { sshKeyId: "k1", host: "target.example", username: "root" };

describe("handleSshSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sshClients.length = 0;
    mockMakeHostKeyVerifier.mockReturnValue(() => {});
  });

  it("wires a host verifier into the final connect", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    expect(conn.connectConfig).not.toBeNull();
    expect(conn.connectConfig!.hostVerifier).toBeTypeOf("function");
    expect(mockMakeHostKeyVerifier).toHaveBeenCalledWith(
      "org-1",
      "target.example",
      22,
      expect.anything(),
      "ssh-proxy",
    );
  });

  it("sends a structured host-key error frame and tears down on verification failure", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    const errorRef = mockMakeHostKeyVerifier.mock.calls[0]![3] as { value: unknown };
    errorRef.value = new HostKeyTrustRequiredError(
      "target.example",
      22,
      "unknown",
      "SHA256:abc",
      null,
    );
    conn.emit("error", new Error("All configured authentication methods failed"));

    expect(ws.sent).toContainEqual(
      expect.objectContaining({
        type: "ssh:error",
        code: "ssh_host_key_trust_required",
        kind: "unknown",
        host: "target.example",
        port: 22,
        presentedFingerprint: "SHA256:abc",
        storedFingerprint: null,
      }),
    );
    expect(conn.ended).toBe(true);
  });

  it("sends a plain error frame for non-host-key connect errors", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    sshClients[0]!.emit("error", new Error("connect ECONNREFUSED"));
    expect(ws.sent).toContainEqual({ type: "ssh:error", error: "connect ECONNREFUSED" });
    expect(sshClients[0]!.ended).toBe(true);
  });

  it("tears down the connection when the ws closes before the shell is ready", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    expect(conn.ended).toBe(false);
    ws.close();
    expect(conn.ended).toBe(true);

    // A "ready" arriving after teardown must not open a shell.
    conn.emit("ready");
    expect(conn.shellCalled).toBe(false);
  });

  it("discards a shell that opens after the ws has closed", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    conn.emit("ready");
    expect(conn.shellCalled).toBe(true);
    ws.close();

    const stream = new FakeShellStream();
    conn.shellCb!(undefined, stream);
    expect(stream.ended).toBe(true);
    expect(ws.sent).not.toContainEqual({ type: "ssh:connected" });
  });

  it("ends the connection when shell open fails", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    conn.emit("ready");
    conn.shellCb!(new Error("shell failed"), undefined as never);
    expect(ws.sent).toContainEqual({ type: "ssh:error", error: "shell failed" });
    expect(conn.ended).toBe(true);
  });

  it("streams shell data and tears down on ws close after connect", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    conn.emit("ready");
    const stream = new FakeShellStream();
    conn.shellCb!(undefined, stream);

    expect(ws.sent).toContainEqual({ type: "ssh:connected" });
    stream.emit("data", Buffer.from("hello"));
    expect(ws.sent).toContainEqual({
      type: "ssh:data",
      data: Buffer.from("hello").toString("base64"),
    });

    ws.close();
    expect(stream.ended).toBe(true);
    // The connection must NOT end synchronously: with SSH compression on,
    // ending it while the channel is still finalizing crashes ssh2 with an
    // uncaught "Invalid Zlib instance". It ends a beat after the channel
    // closes, once the channel's remaining teardown ticks have drained.
    expect(conn.ended).toBe(false);
    stream.emit("close");
    expect(conn.ended).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(conn.ended).toBe(true);
  });

  it("verifies intermediate hops and cleans them up when the ws closes mid-chain", async () => {
    selectRows([KEY_ROW]);
    mockResolveSshChain.mockResolvedValue([
      { host: "jump.example", port: 2222, username: "jb", privateKey: "JUMP_KEY" },
    ]);
    const ws = fakeWs();
    const session = handleSshSession(ws as never, "org-1", "acct-1", undefined, {
      ...DIRECT,
      connectThroughAccountId: "jump-1",
    });

    // conn is created first, then the hop client dials.
    await vi.waitFor(() => expect(sshClients.length).toBe(2));
    const hopClient = sshClients[1]!;
    expect(hopClient.connectConfig!.hostVerifier).toBeTypeOf("function");
    expect(mockMakeHostKeyVerifier).toHaveBeenCalledWith(
      "org-1",
      "jump.example",
      2222,
      expect.anything(),
      "ssh-proxy",
    );

    // Browser tab closes while the hop is still connecting.
    ws.close();
    await session;

    expect(hopClient.ended).toBe(true);
    expect(sshClients[0]!.ended).toBe(true);
    expect(mockForwardOutHop).not.toHaveBeenCalled();
  });

  it("ends intermediate hop clients when a later hop fails", async () => {
    selectRows([KEY_ROW]);
    mockResolveSshChain.mockResolvedValue([
      { host: "jump.example", port: 22, username: "jb", privateKey: "JUMP_KEY" },
    ]);
    mockForwardOutHop.mockRejectedValue(new Error("forward-out failed"));
    const ws = fakeWs();
    const session = handleSshSession(ws as never, "org-1", "acct-1", undefined, {
      ...DIRECT,
      connectThroughAccountId: "jump-1",
    });

    await vi.waitFor(() => expect(sshClients.length).toBe(2));
    const hopClient = sshClients[1]!;
    hopClient.emit("ready");
    await session;

    expect(ws.sent).toContainEqual({ type: "ssh:error", error: "forward-out failed" });
    expect(hopClient.ended).toBe(true);
    expect(sshClients[0]!.ended).toBe(true);
  });
});
