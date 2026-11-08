/**
 * The renderer's end of the Effect RPC transport: an Effect `Socket` over the
 * preload's `rpc` bridge. Acquiring the reader (re)connects, which is what the
 * RPC client does after the main process drops the connection.
 */
import { Effect, Layer } from "effect";
import { Socket } from "effect/socket";

/** What the preload exposes as `window.electronAPI.rpc`. */
export interface RpcBridge {
  connect(): void;
  send(frame: string): void;
  /** Subscribe to frames from the main process; returns an unsubscribe. */
  onFrame(listener: (frame: string) => void): () => void;
}

const decoder = new TextDecoder();

export const makeIpcSocket = (bridge: RpcBridge) =>
  Socket.fromTransformStream(
    Effect.acquireRelease(
      Effect.sync(() => {
        let unsubscribe = () => {};
        const readable = new ReadableStream<string>({
          start(controller) {
            unsubscribe = bridge.onFrame((frame) => controller.enqueue(frame));
          },
          cancel() {
            unsubscribe();
          },
        });
        const writable = new WritableStream<Uint8Array>({
          write(chunk) {
            bridge.send(decoder.decode(chunk));
          },
        });
        bridge.connect();
        return { stream: { readable, writable }, release: () => unsubscribe() };
      }),
      ({ release }) => Effect.sync(release),
    ).pipe(Effect.map(({ stream }) => stream)),
  );

export const layerIpcSocket = (bridge: RpcBridge) =>
  Layer.effect(Socket.Socket)(makeIpcSocket(bridge));
