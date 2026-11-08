/**
 * An Effect `SocketServer` over Electron IPC: one socket per renderer.
 *
 * A renderer connects by sending {@link RPC_CONNECT}; from then on its
 * {@link RPC_FRAME} messages are that socket's incoming frames and the
 * socket's writes go back to it with `webContents.send`. A renderer that
 * connects again (a reload) replaces its previous socket, and a destroyed
 * `webContents` ends its socket, which is how the RPC server learns of the
 * disconnect and interrupts that renderer's in-flight calls.
 */
import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { Effect, FiberMap, Layer } from "effect";
import { NetAddress } from "effect/net";
import { Socket, SocketServer } from "effect/socket";
import { RPC_CONNECT, RPC_FRAME } from "../../shared/rpc/channels";

const decoder = new TextDecoder();

/** The socket for one renderer, alive until its scope closes or the renderer goes. */
const webContentsSocket = (contents: WebContents) =>
  Socket.fromTransformStream(
    Effect.acquireRelease(
      Effect.sync(() => {
        let controller: ReadableStreamDefaultController<string> | undefined;
        const readable = new ReadableStream<string>({
          start(c) {
            controller = c;
          },
        });
        const onFrame = (event: IpcMainEvent, frame: unknown) => {
          if (event.sender === contents && typeof frame === "string") controller?.enqueue(frame);
        };
        const onDestroyed = () => controller?.close();
        ipcMain.on(RPC_FRAME, onFrame);
        contents.once("destroyed", onDestroyed);
        const writable = new WritableStream<Uint8Array>({
          write(chunk) {
            if (!contents.isDestroyed()) contents.send(RPC_FRAME, decoder.decode(chunk));
          },
        });
        const release = () => {
          ipcMain.off(RPC_FRAME, onFrame);
          contents.off("destroyed", onDestroyed);
        };
        return { stream: { readable, writable }, release };
      }),
      ({ release }) => Effect.sync(release),
    ).pipe(Effect.map(({ stream }) => stream)),
  );

export const makeIpcSocketServer = Effect.gen(function* () {
  const address = NetAddress.unixPathAddress("electron-ipc");
  return SocketServer.SocketServer.of({
    address,
    run: <R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) =>
      Effect.gen(function* () {
        // One fiber per renderer, keyed by `webContents.id`: reconnecting
        // interrupts the previous connection's fiber before the new one runs.
        const connections = yield* FiberMap.make<number>();
        const run = yield* FiberMap.runtime(connections)<R>();
        const onConnect = (event: IpcMainEvent) => {
          const contents = event.sender;
          run(
            contents.id,
            Effect.gen(function* () {
              const socket = yield* webContentsSocket(contents);
              return yield* handler(socket);
            }).pipe(Effect.scoped, Effect.ignore),
          );
        };
        ipcMain.on(RPC_CONNECT, onConnect);
        yield* Effect.addFinalizer(() => Effect.sync(() => ipcMain.off(RPC_CONNECT, onConnect)));
        return yield* Effect.never;
      }).pipe(Effect.scoped),
  });
});

export const layerIpcSocketServer = Layer.effect(SocketServer.SocketServer)(makeIpcSocketServer);
