/**
 * Effect RPC over Electron IPC, end to end: the main process's socket server
 * and the renderer's socket, joined through a fake `ipcMain` and
 * `webContents` that behave like Electron's (per-sender events, `send` to one
 * renderer, `destroyed` when it goes).
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

const ipcMain = vi.hoisted(() => {
  const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
  return new Emitter();
});
vi.mock("electron", () => ({ ipcMain }));

const { RPC_CONNECT, RPC_FRAME } = await import("../../shared/rpc/channels");
const { layerIpcSocketServer } = await import("../rpc/ipc-socket-server");
const { layerIpcSocket } = await import("../../src/lib/rpc/ipc-socket");

/** A renderer: its `webContents` as the main process sees it, and its preload bridge. */
function fakeRenderer(id: number) {
  const contents = new EventEmitter() as EventEmitter & {
    id: number;
    destroyed: boolean;
    isDestroyed(): boolean;
    send(channel: string, frame: string): void;
  };
  const listeners = new Set<(frame: string) => void>();
  contents.id = id;
  contents.destroyed = false;
  contents.isDestroyed = () => contents.destroyed;
  contents.send = (channel, frame) => {
    if (channel === RPC_FRAME) for (const l of listeners) queueMicrotask(() => l(frame));
  };
  const bridge = {
    connect: () => ipcMain.emit(RPC_CONNECT, { sender: contents }),
    send: (frame: string) => ipcMain.emit(RPC_FRAME, { sender: contents }, frame),
    onFrame: (listener: (frame: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const destroy = () => {
    contents.destroyed = true;
    contents.emit("destroyed");
  };
  return { bridge, destroy };
}

class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}

class TestRpcs extends RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Refuse", { error: Refused }),
  Rpc.make("Count", { payload: { to: Schema.Int }, success: Schema.Int, stream: true }),
) {}

const Handlers = TestRpcs.toLayer({
  Echo: ({ text }) => Effect.succeed(`echo:${text}`),
  Refuse: () => Effect.fail(new Refused({ message: "not allowed" })),
  Count: ({ to }) => Stream.range(1, to),
});

const ServerLive = RpcServer.layer(TestRpcs).pipe(
  Layer.provide(Handlers),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(layerIpcSocketServer),
  Layer.provide(RpcSerialization.layerJson),
);

class Client extends Context.Service<Client, RpcClient.FromGroup<typeof TestRpcs, unknown>>()(
  "test/Client",
) {}

const clientLayer = (bridge: ReturnType<typeof fakeRenderer>["bridge"]) =>
  Layer.effect(Client)(RpcClient.make(TestRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(layerIpcSocket(bridge)),
    Layer.provide(RpcSerialization.layerJson),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, Client>,
  bridge: ReturnType<typeof fakeRenderer>["bridge"],
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(clientLayer(bridge).pipe(Layer.provide(ServerLive))), Effect.scoped),
  );

describe("Effect RPC over Electron IPC", () => {
  it("answers a call with its decoded success", async () => {
    const { bridge } = fakeRenderer(1);
    const result = await run(
      Effect.gen(function* () {
        const client = yield* Client;
        return yield* client.Echo({ text: "hi" });
      }),
      bridge,
    );
    expect(result).toBe("echo:hi");
  });

  it("delivers a typed failure as the error it was", async () => {
    const { bridge } = fakeRenderer(2);
    const error = await run(
      Effect.gen(function* () {
        const client = yield* Client;
        return yield* Effect.flip(client.Refuse());
      }),
      bridge,
    );
    expect(error).toBeInstanceOf(Refused);
    expect(error).toMatchObject({ _tag: "Refused", message: "not allowed" });
  });

  it("keeps concurrent calls apart and streams in order", async () => {
    const { bridge } = fakeRenderer(3);
    const [echoes, counted] = await run(
      Effect.gen(function* () {
        const client = yield* Client;
        const echoes = yield* Effect.all(
          ["a", "b", "c", "d"].map((text) => client.Echo({ text })),
          { concurrency: "unbounded" },
        );
        const counted = yield* Stream.runCollect(client.Count({ to: 5 }));
        return [echoes, counted] as const;
      }),
      bridge,
    );
    expect(echoes).toEqual(["echo:a", "echo:b", "echo:c", "echo:d"]);
    expect(counted).toEqual([1, 2, 3, 4, 5]);
  });

  it("ignores frames from another renderer", async () => {
    const one = fakeRenderer(4);
    const other = fakeRenderer(5);
    const result = await run(
      Effect.gen(function* () {
        const client = yield* Client;
        // A frame claiming to be a request, from a renderer that never connected.
        other.bridge.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: "Echo",
            payload: { text: "x" },
            headers: [],
          }),
        );
        return yield* client.Echo({ text: "mine" });
      }),
      one.bridge,
    );
    expect(result).toBe("echo:mine");
  });
});
