/**
 * Drive the desktop's real Effect RPC server (`RpcServerLive`, every group
 * and handler `main.ts` starts) from the renderer's real client
 * (`DesktopRpcClient`), joined through a fake `ipcMain` and `webContents`.
 *
 * The test file must mock `electron` with an `EventEmitter` as `ipcMain`
 * (plus whatever else the services under test read, such as `app.getPath`),
 * and mock the low-level modules the services reach (the database getter,
 * the plugin loader) so a handler runs its real logic over fixture data:
 *
 *   vi.mock("electron", async () => {
 *     const { EventEmitter } = await import("node:events");
 *     return { ipcMain: new EventEmitter() };
 *   });
 */
import { EventEmitter } from "node:events";
import { ipcMain } from "electron";
import { Effect, Layer } from "effect";
import { RPC_CONNECT, RPC_FRAME } from "../../shared/rpc/channels";
import { RpcServerLive } from "../rpc/server";
import { DesktopRpcClient } from "../../src/lib/rpc/desktop-client";
import type { RpcBridge } from "../../src/lib/rpc/ipc-socket";

let nextRendererId = 1;

/** A renderer: its `webContents` as the main process sees it, and its preload bridge. */
export function fakeRenderer(id = nextRendererId++) {
  let destroyed = false;
  const listeners = new Set<(frame: string) => void>();
  const contents = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => destroyed,
    send: (channel: string, frame: string) => {
      if (channel === RPC_FRAME) for (const l of listeners) queueMicrotask(() => l(frame));
    },
  });
  const bridge: RpcBridge = {
    connect: () => ipcMain.emit(RPC_CONNECT, { sender: contents }),
    send: (frame) => ipcMain.emit(RPC_FRAME, { sender: contents }, frame),
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const destroy = () => {
    destroyed = true;
    contents.emit("destroyed");
  };
  return { bridge, destroy };
}

/**
 * Run `effect` against a fresh server and a renderer connection (a fresh
 * one unless the test passes the `fakeRenderer()` it wants to destroy
 * midway), both torn down afterwards. Rejects with the operation's typed
 * error, as `runRpc` does in the renderer.
 */
export function callDesktopRpc<A, E>(
  effect: Effect.Effect<A, E, DesktopRpcClient>,
  { bridge } = fakeRenderer(),
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(DesktopRpcClient.layer(bridge).pipe(Layer.provide(RpcServerLive))),
      Effect.scoped,
    ),
  );
}

/** The typed failure of `effect`, failing the test if it succeeds. */
export function failureOf<A, E>(effect: Effect.Effect<A, E, DesktopRpcClient>): Promise<E> {
  return callDesktopRpc(Effect.flip(effect));
}

type FakeRenderer = ReturnType<typeof fakeRenderer>;

/**
 * Several renderers against one server, as in the app (each `callDesktopRpc`
 * builds its own server, whose connection ids start over, so two calls
 * cannot tell renderers apart). `body` gets `as(renderer, effect)`, which
 * runs `effect` over that renderer's connection; nest one `as` inside
 * another to have both renderers connected at once.
 */
export function withSharedServer<A, E>(
  body: (
    as: <X, Y>(
      renderer: FakeRenderer,
      effect: Effect.Effect<X, Y, DesktopRpcClient>,
    ) => Effect.Effect<X, Y>,
  ) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(RpcServerLive);
      return yield* body((renderer, effect) =>
        effect.pipe(Effect.provide(DesktopRpcClient.layer(renderer.bridge)), Effect.scoped),
      );
    }).pipe(Effect.scoped),
  );
}
