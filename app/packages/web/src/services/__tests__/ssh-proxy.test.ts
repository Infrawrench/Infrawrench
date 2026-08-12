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

/**
 * The session-recording tee. Mocked here rather than exercised: it owns its
 * own database access and has its own tests. What this suite cares about is
 * that the proxy drives it correctly and never lets it affect the terminal.
 */
function fakeRecorder() {
  return {
    recordingId: "rec-1",
    onOutput: vi.fn(),
    onInput: vi.fn(),
    onResize: vi.fn(),
    finish: vi.fn().mockResolvedValue(undefined),
  };
}
const mockStartSessionRecording = vi.fn().mockResolvedValue(null);
vi.mock("@infrawrench/server-core/ssh-recording/recorder", () => ({
  startSessionRecording: (...a: unknown[]) => mockStartSessionRecording(...a),
}));

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

// Real DNS is off-limits in tests; the SSRF guard is covered by its own suite.
// What matters here is which address comes back and what the proxy does with it.
const mockResolveSafeHost = vi.fn().mockResolvedValue("203.0.113.7");
vi.mock("@/services/host-validation", () => ({
  resolveSafeHost: (...a: unknown[]) => mockResolveSafeHost(...a),
}));

/**
 * The shared-console hub is real in these tests — the proxy's input and resize
 * gates go through it, and stubbing it would stub out the thing being checked.
 * Its *store* is not: it reaches server-core's own `db/client`, which is a
 * different module specifier from the `@/db/client` mocked above and would
 * demand a DATABASE_URL. An unshared session never calls any of these, so
 * every stub below is a no-op the suite should never reach.
 */
vi.mock("@infrawrench/server-core/shared-console/store", () => ({
  closeSharedConsole: vi.fn().mockResolvedValue(null),
  getSharedConsoleByLiveId: vi.fn().mockResolvedValue(null),
  listParticipants: vi.fn().mockResolvedValue([]),
  readShareStates: vi.fn().mockResolvedValue(new Map()),
  recordViewport: vi.fn().mockResolvedValue(undefined),
  setPtySize: vi.fn().mockResolvedValue(undefined),
  touchParticipant: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: vi
    .fn()
    .mockResolvedValue({ permissions: [], role: null, elevations: [] }),
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

/**
 * Wait for `conn.shell` to be called after a "ready".
 *
 * The shell opens one tick behind the handshake now: the recorder is opened
 * first so a prompt or MOTD arriving mid-insert isn't missing from the top of
 * the cast. That makes the ordering asynchronous even when nothing is being
 * recorded.
 */
async function openedShell(conn: FakeSshClient): Promise<void> {
  await vi.waitFor(() => expect(conn.shellCalled).toBe(true));
}

describe("handleSshSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sshClients.length = 0;
    mockMakeHostKeyVerifier.mockReturnValue(() => {});
    mockStartSessionRecording.mockResolvedValue(null);
    mockResolveSafeHost.mockResolvedValue("203.0.113.7");
  });

  it("refuses a direct-SSH host in blocked address space", async () => {
    selectRows([KEY_ROW]);
    mockResolveSafeHost.mockRejectedValueOnce(
      new Error("SSH host 127.0.0.1 resolves to a blocked address range"),
    );
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, {
      ...DIRECT,
      host: "127.0.0.1",
    });

    expect(mockResolveSafeHost).toHaveBeenCalledWith("127.0.0.1");
    expect(sshClients).toHaveLength(0);
    expect(ws.sent).toContainEqual({
      type: "ssh:error",
      error: "SSH host 127.0.0.1 resolves to a blocked address range",
    });
  });

  it("dials the vetted address, not the name it validated", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    // Handing ssh2 the hostname would let it resolve a second time, which is
    // the whole rebinding window: check answers public, connect answers
    // 169.254.169.254. Only the cleared address may reach the socket.
    expect(mockResolveSafeHost).toHaveBeenCalledWith("target.example");
    expect(sshClients[0]!.connectConfig).toMatchObject({ host: "203.0.113.7", port: 22 });
  });

  it("keeps host-key identity on the hostname while dialing the address", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    // Pins live in `ssh_host_keys` keyed by (host, port). Verify against the
    // IP and every already-trusted host silently asks to be trusted again.
    expect(mockMakeHostKeyVerifier).toHaveBeenCalledWith(
      "org-1",
      "target.example",
      22,
      expect.anything(),
      "ssh-proxy",
    );
  });

  it("skips the SSRF guard when jumping through a bastion", async () => {
    selectRows([KEY_ROW]);
    mockResolveSshChain.mockResolvedValue([
      { host: "jump.example", port: 22, username: "jb", privateKey: "JUMP_KEY" },
    ]);
    mockForwardOutHop.mockRejectedValue(new Error("stop here"));
    const ws = fakeWs();
    // A private target is exactly what a jump host is for, so the guard must
    // not fire — reaching hop establishment at all proves it didn't.
    const session = handleSshSession(ws as never, "org-1", "acct-1", undefined, {
      ...DIRECT,
      host: "10.0.0.5",
      connectThroughAccountId: "jump-1",
    });

    await vi.waitFor(() => expect(sshClients.length).toBe(2));
    sshClients[1]!.emit("ready");
    await session;

    expect(mockResolveSafeHost).not.toHaveBeenCalled();
    // The bastion itself is dialed by name too: its endpoint comes from a
    // stored account, not from the frame, and is routinely private on purpose.
    expect(sshClients[1]!.connectConfig).toMatchObject({ host: "jump.example" });
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conn.shellCalled).toBe(false);
  });

  it("discards a shell that opens after the ws has closed", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    conn.emit("ready");
    await openedShell(conn);
    ws.close();

    const stream = new FakeShellStream();
    conn.shellCb!(undefined, stream);
    expect(stream.ended).toBe(true);
    expect(ws.sent.map((f) => (f as { type: string }).type)).not.toContain("ssh:connected");
  });

  it("ends the connection when shell open fails", async () => {
    selectRows([KEY_ROW]);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    conn.emit("ready");
    await openedShell(conn);
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
    await openedShell(conn);
    const stream = new FakeShellStream();
    conn.shellCb!(undefined, stream);

    // The frame also carries `liveConsoleId` (and `routingKey` when the
    // client sent one), so match on the type rather than the whole object.
    expect(ws.sent.map((f) => (f as { type: string }).type)).toContain("ssh:connected");
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

  it("tees output, input and resizes into the recorder, and settles it on close", async () => {
    selectRows([KEY_ROW]);
    const recorder = fakeRecorder();
    mockStartSessionRecording.mockResolvedValue(recorder);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", "res-9", DIRECT, 120, 40, false, "u-1");

    const conn = sshClients[0]!;
    conn.emit("ready");
    await openedShell(conn);

    // The recording is opened with the session's identity and geometry, so a
    // tape can be attributed without joining anything that may since be gone.
    expect(mockStartSessionRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        userId: "u-1",
        accountId: "acct-1",
        resourceId: "res-9",
        host: "target.example",
        username: "root",
        hopCount: 1,
        cols: 120,
        rows: 40,
      }),
    );

    const stream = new FakeShellStream();
    conn.shellCb!(undefined, stream);

    stream.emit("data", Buffer.from("stdout"));
    stream.stderr.emit("data", Buffer.from("stderr"));
    expect(recorder.onOutput).toHaveBeenCalledTimes(2);

    ws.emit("message", JSON.stringify({ type: "ssh:data", data: btoa("ls\r") }));
    expect(recorder.onInput).toHaveBeenCalledTimes(1);
    // The keystroke still reaches the host — the tee is a second consumer,
    // never a filter.
    expect(stream.written).toHaveLength(1);

    ws.emit("message", JSON.stringify({ type: "ssh:resize", cols: 100, rows: 30 }));
    expect(recorder.onResize).toHaveBeenCalledWith(100, 30);

    ws.close();
    expect(recorder.finish).toHaveBeenCalled();
  });

  it("keeps the terminal working when the recorder cannot be opened", async () => {
    selectRows([KEY_ROW]);
    // `startSessionRecording` returns null for every not-recording case — opted
    // out, settings unreadable, insert failed — so the proxy has one branch and
    // a broken recorder is indistinguishable from recording being off.
    mockStartSessionRecording.mockResolvedValue(null);
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    conn.emit("ready");
    await openedShell(conn);
    const stream = new FakeShellStream();
    conn.shellCb!(undefined, stream);

    // The frame also carries `liveConsoleId` (and `routingKey` when the
    // client sent one), so match on the type rather than the whole object.
    expect(ws.sent.map((f) => (f as { type: string }).type)).toContain("ssh:connected");
    stream.emit("data", Buffer.from("hello"));
    expect(ws.sent).toContainEqual({
      type: "ssh:data",
      data: Buffer.from("hello").toString("base64"),
    });
  });

  it("settles an empty recording when the ws closes while it is opening", async () => {
    selectRows([KEY_ROW]);
    const recorder = fakeRecorder();
    let release: (() => void) | null = null;
    mockStartSessionRecording.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(recorder);
      }),
    );
    const ws = fakeWs();
    await handleSshSession(ws as never, "org-1", "acct-1", undefined, DIRECT);

    const conn = sshClients[0]!;
    conn.emit("ready");
    await vi.waitFor(() => expect(release).not.toBeNull());
    ws.close();
    release!();

    // No shell — but the row must not be left saying "recording" forever.
    await vi.waitFor(() => expect(recorder.finish).toHaveBeenCalled());
    expect(conn.shellCalled).toBe(false);
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
