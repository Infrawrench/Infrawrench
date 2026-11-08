/**
 * Interactive SSH shells and host-key prompts over Effect RPC, end to end:
 * the renderer's real RPC client talks through a fake `ipcMain`/`webContents`
 * to the real handlers, services and host-key store, with ssh2's `Client`
 * replaced by a fake that never touches the network. The renderer's terminal
 * handle over this client is tested in `src/lib/__tests__/ssh-dispatch.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import type { DesktopRpcClient as DesktopRpcClientService } from "../../src/lib/rpc/desktop-client";

const fakes = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  /** Answers the host-key check with this key; unknown hosts get `keyA`. */
  const hostKeys = new Map<string, Buffer>();
  const authFails = new Set<string>();
  const keyA = Buffer.from("host-key-a");
  const keyB = Buffer.from("host-key-b");

  class FakeChannel extends EventEmitter {
    readonly stderr = new EventEmitter();
    readonly written: string[] = [];
    readonly windows: { rows: number; cols: number }[] = [];
    ended = false;
    write(data: string): boolean {
      this.written.push(data);
      return true;
    }
    setWindow(rows: number, cols: number): void {
      this.windows.push({ rows, cols });
    }
    end(): void {
      this.ended = true;
      setTimeout(() => this.emit("close"), 0);
    }
  }

  interface ConnectOptions {
    host?: string;
    hostVerifier?: (key: Buffer, verify: (ok: boolean) => void) => void;
  }

  class FakeClient extends EventEmitter {
    static readonly instances: FakeClient[] = [];
    host = "";
    ended = false;
    channel: FakeChannel | undefined;
    shellSize: { cols: number; rows: number } | undefined;
    constructor() {
      super();
      FakeClient.instances.push(this);
    }
    connect(opts: ConnectOptions): void {
      this.host = opts.host ?? "";
      const key = hostKeys.get(this.host) ?? keyA;
      setTimeout(() => {
        opts.hostVerifier?.(key, (ok) => {
          if (!ok) {
            this.emit("error", new Error("Host denied (verification failed)"));
          } else if (authFails.has(this.host)) {
            this.emit("error", new Error("All configured authentication methods failed"));
          } else {
            this.emit("ready");
          }
        });
      }, 0);
    }
    shell(
      size: { cols: number; rows: number },
      callback: (err: Error | undefined, channel: FakeChannel) => void,
    ): void {
      this.shellSize = size;
      this.channel = new FakeChannel();
      callback(undefined, this.channel);
    }
    end(): void {
      this.ended = true;
    }
  }

  /** The `ssh_host_keys` table. */
  const pins: { id: string; host: string; port: number; fingerprint: string }[] = [];
  const executed: { sql: string; params: unknown[] }[] = [];
  const ipcMain = new EventEmitter();

  return { EventEmitter, hostKeys, authFails, keyA, keyB, FakeClient, pins, executed, ipcMain };
});

vi.mock("electron", () => ({ ipcMain: fakes.ipcMain }));
vi.mock("ssh2", async (importOriginal) => {
  const { Predicate } = await import("effect");
  const actual = await importOriginal<typeof import("ssh2")>();
  // ssh2 is CommonJS: `ssh-tunnel-core` reads it through the default export.
  const exports: unknown = Reflect.get(actual, "default");
  const base = Predicate.isObject(exports) ? exports : actual;
  return { ...actual, Client: fakes.FakeClient, default: { ...base, Client: fakes.FakeClient } };
});
vi.mock("../main-utils", () => ({
  getDb: async () => ({
    select: async () => fakes.pins,
    execute: async (sql: string, params: unknown[]) => {
      fakes.executed.push({ sql, params });
    },
  }),
}));
vi.mock("../cloud-key-agent", () => ({ buildCloudKeyAgent: () => null }));

const { sha256Fingerprint } = await import("@infrawrench/ssh-tunnel-core");
const { RPC_CONNECT, RPC_DISCONNECT, RPC_FRAME } = await import("../../shared/rpc/channels");
const { layerIpcSocketServer } = await import("../rpc/ipc-socket-server");
const { SshShellRpcs } = await import("../../shared/rpc/groups/ssh-shell");
const { SshHostKeyRpcs } = await import("../../shared/rpc/groups/ssh-host-keys");
const { SshHostKeyHandlers, SshShellHandlers } = await import("../rpc/handlers/ssh-shell");
const { DesktopRpcClient } = await import("../../src/lib/rpc/desktop-client");

// Pins the store starts with: the shell hosts are already trusted, and
// `mismatch.example` is pinned to a key it no longer presents.
fakes.pins.push(
  { id: "1", host: "host.example", port: 22, fingerprint: sha256Fingerprint(fakes.keyA) },
  { id: "2", host: "mismatch.example", port: 22, fingerprint: sha256Fingerprint(fakes.keyA) },
  { id: "3", host: "denied.example", port: 22, fingerprint: sha256Fingerprint(fakes.keyA) },
);
fakes.hostKeys.set("mismatch.example", fakes.keyB);
fakes.authFails.add("denied.example");

class FakeContents extends fakes.EventEmitter {
  destroyed = false;
  readonly frameListeners = new Set<(frame: string) => void>();
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, frame: string): void {
    if (channel !== RPC_FRAME) return;
    for (const listener of this.frameListeners) queueMicrotask(() => listener(frame));
  }
}

let nextRendererId = 100;

/** A renderer page: its `webContents` as main sees it, and its preload bridge. */
function fakeRenderer(token = `page-${nextRendererId}`) {
  const contents = new FakeContents(nextRendererId++);
  const bridge = {
    connect: () => fakes.ipcMain.emit(RPC_CONNECT, { sender: contents }, token),
    send: (frame: string) => fakes.ipcMain.emit(RPC_FRAME, { sender: contents }, frame),
    onFrame: (listener: (frame: string) => void) => {
      contents.frameListeners.add(listener);
      return () => {
        contents.frameListeners.delete(listener);
      };
    },
  };
  return {
    bridge,
    destroy: () => {
      contents.destroyed = true;
      contents.emit("destroyed");
    },
    /** What the preload sends on `pagehide`. */
    pageHide: (from = token) => fakes.ipcMain.emit(RPC_DISCONNECT, { sender: contents }, from),
  };
}

class TestRpcs extends SshShellRpcs.merge(SshHostKeyRpcs) {}

const ServerLive = RpcServer.layer(TestRpcs).pipe(
  Layer.provide(Layer.mergeAll(SshShellHandlers, SshHostKeyHandlers)),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(layerIpcSocketServer),
  Layer.provide(RpcSerialization.layerJson),
);

type Bridge = ReturnType<typeof fakeRenderer>["bridge"];

/** Run `effect` as a renderer over `bridge`, with the main process serving. */
const run = <A, E>(bridge: Bridge, effect: Effect.Effect<A, E, DesktopRpcClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(DesktopRpcClient.layer(bridge).pipe(Layer.provideMerge(ServerLive))),
      Effect.scoped,
    ),
  );

const shellConfig = (host: string) => ({
  host,
  port: 22,
  username: "root",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  cols: 80,
  rows: 24,
});

const waitFor = (check: () => void) => Effect.promise(() => vi.waitFor(check));

/** The latest connection to `host`. */
function clientFor(host: string) {
  const client = fakes.FakeClient.instances.filter((c) => c.host === host).at(-1);
  if (!client) throw new Error(`no connection to ${host}`);
  return client;
}

function channelOf(host: string) {
  const channel = clientFor(host).channel;
  if (!channel) throw new Error(`no shell on ${host}`);
  return channel;
}

/** Open a shell and collect its events until it is interrupted or ends. */
const openShell = (host: string) =>
  Effect.gen(function* () {
    const rpc = yield* DesktopRpcClient;
    const events: string[] = [];
    let shellId: string | undefined;
    const fiber = yield* Stream.runForEach(rpc.SshShellOpen(shellConfig(host)), (event) =>
      Effect.sync(() => {
        if (event._tag === "Opened") shellId = event.shellId;
        else events.push(Buffer.from(event.data).toString("utf8"));
      }),
    ).pipe(Effect.forkChild);
    yield* waitFor(() => expect(shellId).toBeDefined());
    return { fiber, events, shellId: shellId ?? "" };
  });

/** Answer every host-key prompt this renderer is shown with `accept`. */
const answerPrompts = (accept: boolean, seen: string[]) =>
  Effect.gen(function* () {
    const rpc = yield* DesktopRpcClient;
    yield* Stream.runForEach(rpc.SshHostKeyPrompts(), (event) =>
      event._tag === "Prompt"
        ? Effect.andThen(
            Effect.sync(() => seen.push(`${event.prompt.kind}:${event.prompt.host}`)),
            rpc.SshHostKeyDecide({ requestId: event.prompt.requestId, accept }),
          )
        : Effect.void,
    );
  }).pipe(Effect.forkChild);

describe("SSH shells over Effect RPC", () => {
  it("opens a shell, streams its output, and takes keystrokes and resizes", async () => {
    const { bridge } = fakeRenderer();
    const result = await run(
      bridge,
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const { fiber, events, shellId } = yield* openShell("host.example");
        const channel = channelOf("host.example");
        channel.emit("data", Buffer.from("Welcome\r\n"));
        channel.stderr.emit("data", Buffer.from("warning\r\n"));
        yield* waitFor(() => expect(events).toEqual(["Welcome\r\n", "warning\r\n"]));
        yield* rpc.SshShellWrite({ shellId, data: "ls\n" });
        yield* rpc.SshShellResize({ shellId, cols: 120, rows: 40 });
        // The remote shell exits: the stream ends, and the connection with it.
        channel.emit("close");
        const exit = yield* Fiber.await(fiber);
        return { exit, channel };
      }),
    );
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.channel.written).toEqual(["ls\n"]);
    expect(result.channel.windows).toEqual([{ rows: 40, cols: 120 }]);
    expect(clientFor("host.example").shellSize).toMatchObject({ cols: 80, rows: 24 });
    await vi.waitFor(() => expect(clientFor("host.example").ended).toBe(true));
  });

  it("closing the terminal interrupts the stream, which releases the channel and the connection", async () => {
    const { bridge } = fakeRenderer();
    const channel = await run(
      bridge,
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const { fiber, shellId } = yield* openShell("host.example");
        const channel = channelOf("host.example");
        yield* Fiber.interrupt(fiber);
        yield* waitFor(() => expect(channel.ended).toBe(true));
        yield* waitFor(() => expect(clientFor("host.example").ended).toBe(true));
        // A released shell takes no more input.
        yield* rpc.SshShellWrite({ shellId, data: "late\n" });
        return channel;
      }),
    );
    expect(channel.written).toEqual([]);
  });

  it("a renderer that goes away releases its shells", async () => {
    const renderer = fakeRenderer();
    await run(
      renderer.bridge,
      Effect.gen(function* () {
        yield* openShell("host.example");
        const channel = channelOf("host.example");
        renderer.destroy();
        yield* waitFor(() => expect(channel.ended).toBe(true));
        yield* waitFor(() => expect(clientFor("host.example").ended).toBe(true));
      }),
    );
  });

  it("a reloading page releases its shells on pagehide, and ignores a stale page's token", async () => {
    const renderer = fakeRenderer("this-page");
    await run(
      renderer.bridge,
      Effect.gen(function* () {
        yield* openShell("host.example");
        const channel = channelOf("host.example");
        renderer.pageHide("an-earlier-page");
        yield* Effect.sleep(50);
        expect(channel.ended).toBe(false);
        renderer.pageHide();
        yield* waitFor(() => expect(channel.ended).toBe(true));
        yield* waitFor(() => expect(clientFor("host.example").ended).toBe(true));
      }),
    );
  });

  it("an authentication failure fails the stream with ssh2's reason", async () => {
    const { bridge } = fakeRenderer();
    const error = await run(
      bridge,
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        return yield* Effect.flip(Stream.runDrain(rpc.SshShellOpen(shellConfig("denied.example"))));
      }),
    );
    expect(error).toMatchObject({
      _tag: "SshError",
      message: "SSH error: All configured authentication methods failed",
    });
  });

  it("a changed host key asks the renderer, and a denial refuses the connection", async () => {
    const { bridge } = fakeRenderer();
    const seen: string[] = [];
    const error = await run(
      bridge,
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* answerPrompts(false, seen);
        yield* Effect.sleep(20);
        return yield* Effect.flip(
          Stream.runDrain(rpc.SshShellOpen(shellConfig("mismatch.example"))),
        );
      }),
    );
    expect(seen).toEqual(["mismatch:mismatch.example"]);
    expect(error).toMatchObject({ _tag: "SshError" });
    expect(error.message).toBe(
      `SSH host key for mismatch.example:22 changed (stored=${sha256Fingerprint(fakes.keyA)}, ` +
        `presented=${sha256Fingerprint(fakes.keyB)}). Refusing to connect. ` +
        `Delete the pin in ssh_host_keys to accept the new key.`,
    );
  });

  it("a first connection asks the renderer, and accepting pins the key", async () => {
    const { bridge } = fakeRenderer();
    const seen: string[] = [];
    await run(
      bridge,
      Effect.gen(function* () {
        yield* answerPrompts(true, seen);
        yield* Effect.sleep(20);
        yield* openShell("new.example");
      }),
    );
    expect(seen).toEqual(["first-connect:new.example"]);
    await vi.waitFor(() =>
      expect(fakes.executed.some((e) => e.sql.startsWith("INSERT INTO ssh_host_keys"))).toBe(true),
    );
    expect(fakes.executed.find((e) => e.sql.startsWith("INSERT"))?.params).toEqual([
      expect.any(String),
      "new.example",
      22,
      sha256Fingerprint(fakes.keyA),
    ]);
  });

  it("with no window to ask, an unknown host key is refused", async () => {
    const { bridge } = fakeRenderer();
    const error = await run(
      bridge,
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        return yield* Effect.flip(Stream.runDrain(rpc.SshShellOpen(shellConfig("lonely.example"))));
      }),
    );
    expect(error.message).toContain("SSH host key for lonely.example:22 changed (stored=(none)");
  });
});
