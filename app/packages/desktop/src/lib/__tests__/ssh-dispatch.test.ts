import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const getCloudWsUrl = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../cloud-ws", () => ({ getCloudWsUrl: () => getCloudWsUrl() }));
vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

import { type Cause, Effect, Predicate, Queue, Stream } from "effect";
import { SshError } from "../../../shared/rpc/groups/ssh-common";
import type { SshShellEvent } from "../../../shared/rpc/groups/ssh-shell";
import { openSshShell } from "../ssh-dispatch";
import { fakeRpc, resetFakeRpc } from "./fake-rpc";

// ---- fakes ----------------------------------------------------------------

interface Listener {
  on: (channel: string, cb: (...args: unknown[]) => void) => void;
  offAll: (channel: string) => void;
}

function makeElectronApi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const api: Listener & {
    emit: (channel: string, ...args: unknown[]) => void;
    offAllCalls: string[];
  } = {
    on: (channel, cb) => {
      const list = handlers.get(channel) ?? [];
      list.push(cb);
      handlers.set(channel, list);
    },
    offAll: (channel) => {
      api.offAllCalls.push(channel);
      handlers.delete(channel);
    },
    emit: (channel, ...args) => {
      for (const cb of handlers.get(channel) ?? []) cb(...args);
    },
    offAllCalls: [],
  };
  return api;
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static OPEN_VAL = 1;
  url: string;
  binaryType = "";
  readyState = 1;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: { data: unknown }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: { data: unknown }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  dispatch(type: string, ev: { data: unknown } = { data: "" }) {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.dispatch("close");
  }
}
// match the WebSocket.OPEN static referenced in source
(FakeWebSocket as unknown as { OPEN: number }).OPEN = 1;

beforeEach(() => {
  resetFakeRpc();
  invoke.mockReset();
  getCloudWsUrl.mockReset();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openSshShell (local mode)", () => {
  /** A main process that opens `shell-1` and lets the test drive its output. */
  function fakeShell() {
    const opened: unknown[] = [];
    const writes: string[] = [];
    const resizes: unknown[] = [];
    let interrupted = false;
    let output: Queue.Queue<SshShellEvent, Cause.Done> | undefined;
    fakeRpc.SshShellOpen = (config: unknown) => {
      opened.push(config);
      return Stream.callback<SshShellEvent>((queue) =>
        Effect.gen(function* () {
          output = queue;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          );
          yield* Queue.offer(queue, { _tag: "Opened", shellId: "shell-1" });
        }),
      );
    };
    fakeRpc.SshShellWrite = (payload: unknown) =>
      Effect.sync(() => {
        if (Predicate.hasProperty(payload, "data") && Predicate.isString(payload.data)) {
          writes.push(payload.data);
        }
      });
    fakeRpc.SshShellResize = (payload: unknown) =>
      Effect.sync(() => {
        resizes.push(payload);
      });
    const emit = (event: SshShellEvent) => {
      if (output) Queue.offerUnsafe(output, event);
    };
    const end = () => {
      if (output) Queue.endUnsafe(output);
    };
    return { opened, writes, resizes, emit, end, isInterrupted: () => interrupted };
  }

  it("opens one SshShellOpen stream and routes data, input, resize and exit", async () => {
    const shell = fakeShell();
    const handle = await openSshShell({
      mode: "local",
      host: "h",
      port: 22,
      username: "u",
      privateKey: "k",
      cols: 80,
      rows: 24,
      agentForward: true,
      jumpHops: [{ host: "j", port: 22, username: "ju", privateKey: "jk" }],
    });

    expect(handle.kind).toBe("local");
    expect(shell.opened).toEqual([
      {
        host: "h",
        port: 22,
        username: "u",
        privateKey: "k",
        cols: 80,
        rows: 24,
        agentForward: true,
        jumpHops: [{ host: "j", port: 22, username: "ju", privateKey: "jk" }],
      },
    ]);

    const received: Uint8Array[] = [];
    handle.onData((d) => received.push(d));
    shell.emit({ _tag: "Data", data: new Uint8Array([1, 2, 3]) });
    await vi.waitFor(() => expect(received).toEqual([new Uint8Array([1, 2, 3])]));

    handle.write("l");
    handle.write("s\n");
    await vi.waitFor(() => expect(shell.writes.join("")).toBe("ls\n"));
    handle.resize(100, 40);
    await vi.waitFor(() =>
      expect(shell.resizes).toEqual([{ shellId: "shell-1", cols: 100, rows: 40 }]),
    );

    // The remote shell exits: the stream ends.
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    shell.end();
    await vi.waitFor(() => expect(exits).toHaveLength(1));
  });

  it("kill interrupts the stream, and is idempotent", async () => {
    const shell = fakeShell();
    const handle = await openSshShell({
      mode: "local",
      host: "h",
      port: 22,
      username: "u",
      privateKey: "k",
      cols: 80,
      rows: 24,
    });
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    handle.kill();
    await vi.waitFor(() => expect(shell.isInterrupted()).toBe(true));
    handle.write("x"); // no-op after kill
    handle.resize(1, 1); // no-op after kill
    handle.kill(); // idempotent
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shell.writes).toEqual([]);
    expect(shell.resizes).toEqual([]);
    // A terminal the user closed is not told its connection closed.
    expect(exits).toEqual([]);
  });

  it("omits jumpHops and agentForward when not asked for", async () => {
    const shell = fakeShell();
    await openSshShell({
      mode: "local",
      host: "h",
      port: 22,
      username: "u",
      privateKey: "k",
      cols: 80,
      rows: 24,
    });
    expect(shell.opened[0]).not.toHaveProperty("jumpHops");
    expect(shell.opened[0]).not.toHaveProperty("agentForward");
  });

  it("rejects with the main process's sentence when the shell cannot open", async () => {
    fakeRpc.SshShellOpen = () =>
      Stream.fail(
        new SshError({ message: "SSH error: All configured authentication methods failed" }),
      );
    await expect(
      openSshShell({
        mode: "local",
        host: "h",
        port: 22,
        username: "u",
        privateKey: "k",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow("SSH error: All configured authentication methods failed");
  });
});

describe("openSshShell (cloud mode)", () => {
  it("throws when there is no ws token", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    fakeRpc["CloudWsToken"] = () => Effect.succeed(null);
    await expect(
      openSshShell({
        mode: "cloud",
        orgId: "org1",
        keySource: { type: "cloud", sshKeyId: "key1", name: "k" },
        accountId: "acc",
        host: "h",
        username: "u",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/Not authenticated/);
  });

  it("opens a websocket, sends ssh:open, and decodes ssh:data/closed/error", async () => {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    fakeRpc["CloudWsToken"] = () => Effect.succeed("ws-token-abc");
    getCloudWsUrl.mockResolvedValue("ws://localhost:3000");

    const handle = await openSshShell({
      mode: "cloud",
      orgId: "org1",
      keySource: { type: "cloud", sshKeyId: "key1", name: "k" },
      accountId: "acc",
      resourceId: "res",
      host: "h",
      username: "u",
      cols: 80,
      rows: 24,
      agentForward: true,
      connectThroughAccountId: "jump-acc",
    });
    expect(handle.kind).toBe("cloud");

    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain("ws://localhost:3000/api/ws?token=ws-token-abc");

    // open -> sends ssh:open with all fields
    ws.dispatch("open");
    const openMsg = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(openMsg).toMatchObject({
      type: "ssh:open",
      accountId: "acc",
      resourceId: "res",
      sshKeyId: "key1",
      sshHost: "h",
      sshUsername: "u",
      agentForward: true,
      connectThroughAccountId: "jump-acc",
    });

    // data event -> base64 decoded to bytes
    const datas: Uint8Array[] = [];
    handle.onData((d) => datas.push(d));
    const payload = btoa("hi");
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:data", data: payload }) });
    expect(new TextDecoder().decode(datas[0])).toBe("hi");

    // error event
    const errs: string[] = [];
    handle.onError((e) => errs.push(e));
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:error", error: "boom" }) });
    expect(errs[0]).toBe("boom");

    // malformed message ignored
    ws.dispatch("message", { data: "not json" });

    // closed event -> exit
    const exits: number[] = [];
    handle.onExit(() => exits.push(1));
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:closed" }) });
    expect(exits).toHaveLength(1);

    // write -> base64 ssh:data. Writes are buffered until the proxy reports
    // the shell is up, so announce that first (see the buffering suite below).
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:connected" }) });
    handle.write("ab");
    const writeMsg = JSON.parse(ws.sent.at(-1)!) as { type: string; data: string };
    expect(writeMsg.type).toBe("ssh:data");
    expect(atob(writeMsg.data)).toBe("ab");

    // resize
    handle.resize(120, 50);
    const resizeMsg = JSON.parse(ws.sent.at(-1)!) as Record<string, unknown>;
    expect(resizeMsg).toMatchObject({ type: "ssh:resize", cols: 120, rows: 50 });

    // kill closes the socket; subsequent writes are no-ops
    handle.kill();
    expect(ws.closed).toBe(true);
    const sentBefore = ws.sent.length;
    handle.write("x");
    expect(ws.sent.length).toBe(sentBefore);
  });
});

describe("openSshShell (cloud mode) — write buffering", () => {
  async function openCloud() {
    vi.stubGlobal("window", { electronAPI: makeElectronApi() });
    fakeRpc["CloudWsToken"] = () => Effect.succeed("ws-token-abc");
    invoke.mockResolvedValue(true);
    getCloudWsUrl.mockResolvedValue("ws://localhost:3000");
    const handle = await openSshShell({
      mode: "cloud",
      orgId: "org1",
      keySource: { type: "cloud", sshKeyId: "key1", name: "k" },
      accountId: "acc",
      resourceId: "res",
      host: "h",
      username: "u",
      cols: 80,
      rows: 24,
    });
    return { handle, ws: FakeWebSocket.instances[0]! };
  }

  function dataFrames(ws: FakeWebSocket): string[] {
    return ws.sent
      .map((raw) => JSON.parse(raw) as { type: string; data?: string })
      .filter((m) => m.type === "ssh:data")
      .map((m) => atob(m.data ?? ""));
  }

  // The regression: agent tabs write their launch command the instant the
  // handle resolves. The socket is still CONNECTING then, and the proxy only
  // registers its ssh:data listener inside conn.shell(), so an unbuffered
  // write is dropped twice over and the user lands on a bare shell prompt.
  it("holds writes until ssh:connected, then flushes them in order", async () => {
    const { handle, ws } = await openCloud();

    handle.write("t3 connect link\n");
    handle.write("second\n");
    ws.dispatch("open");
    expect(dataFrames(ws)).toEqual([]);

    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:connected" }) });
    expect(dataFrames(ws)).toEqual(["t3 connect link\n", "second\n"]);
  });

  it("sends straight through once connected", async () => {
    const { handle, ws } = await openCloud();
    ws.dispatch("open");
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:connected" }) });

    handle.write("later\n");
    expect(dataFrames(ws)).toEqual(["later\n"]);
  });

  it("drops buffered writes when the handle is killed", async () => {
    const { handle, ws } = await openCloud();
    handle.write("never\n");
    handle.kill();
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:connected" }) });
    expect(dataFrames(ws)).toEqual([]);
  });

  // A shell that never connects must not accumulate writes without bound.
  it("caps the pending buffer", async () => {
    const { handle, ws } = await openCloud();
    for (let i = 0; i < 300; i++) handle.write(`${i}\n`);
    ws.dispatch("message", { data: JSON.stringify({ type: "ssh:connected" }) });
    expect(dataFrames(ws)).toHaveLength(256);
  });
});
