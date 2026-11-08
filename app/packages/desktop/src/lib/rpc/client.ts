/**
 * The renderer's Effect RPC client to the desktop main process.
 *
 * One connection for the whole renderer, built on first use and kept for its
 * life. Components call {@link runRpc} with an Effect over
 * {@link DesktopRpcClient}; the payload is encoded, and the answer decoded,
 * against the operation's schemas in `shared/rpc/groups`, the same ones the
 * main process uses.
 */
import { Effect, Fiber, ManagedRuntime, Predicate } from "effect";
import { DesktopRpcClient } from "./desktop-client";
import type { RpcBridge } from "./ipc-socket";

export { DesktopRpcClient };

function rpcBridge(): RpcBridge {
  const bridge: unknown = window.electronAPI?.["rpc"];
  if (!isRpcBridge(bridge)) {
    throw new Error("Electron preload script not loaded: no RPC bridge on window.electronAPI");
  }
  return bridge;
}

const isRpcBridge = (value: unknown): value is RpcBridge =>
  Predicate.hasProperty(value, "connect") &&
  Predicate.isFunction(value.connect) &&
  Predicate.hasProperty(value, "send") &&
  Predicate.isFunction(value.send) &&
  Predicate.hasProperty(value, "onFrame") &&
  Predicate.isFunction(value.onFrame);

let runtime: ManagedRuntime.ManagedRuntime<DesktopRpcClient, never> | undefined;

/** Run an RPC call from React code; rejects with the operation's typed error. */
export function runRpc<A, E>(effect: Effect.Effect<A, E, DesktopRpcClient>): Promise<A> {
  runtime ??= ManagedRuntime.make(DesktopRpcClient.layer(rpcBridge()));
  return runtime.runPromise(effect);
}

/**
 * Start a long-lived RPC effect from React code, such as consuming a stream
 * (`Stream.runForEach(rpc.SshShellOpen(...), ...)`), and return the function
 * that stops it. Stopping interrupts the fiber, and an interrupted stream
 * tells the main process to interrupt its end too, which is what releases
 * whatever the stream holds there. Handle the outcome inside `effect`
 * (`Effect.onExit`); nothing is reported here.
 */
export function forkRpc<A, E>(effect: Effect.Effect<A, E, DesktopRpcClient>): () => void {
  runtime ??= ManagedRuntime.make(DesktopRpcClient.layer(rpcBridge()));
  const fiber = runtime.runFork(effect);
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
}
