/**
 * The renderer's Effect RPC client to the desktop main process.
 *
 * One connection for the whole renderer, built on first use and kept for its
 * life. Components call {@link runRpc} with an Effect over
 * {@link DesktopRpcClient}; the payload is encoded, and the answer decoded,
 * against the operation's schemas in `shared/rpc/groups`, the same ones the
 * main process uses.
 */
import { Context, Effect, Layer, ManagedRuntime, Predicate } from "effect";
import { RpcClient, RpcSerialization, type RpcClientError } from "effect/rpc";
import { DesktopRpcs } from "../../../shared/rpc/groups";
import { layerIpcSocket, type RpcBridge } from "./ipc-socket";

export class DesktopRpcClient extends Context.Service<
  DesktopRpcClient,
  RpcClient.FromGroup<typeof DesktopRpcs, RpcClientError.RpcClientError>
>()("infrawrench/desktop/DesktopRpcClient") {
  static readonly layer = (bridge: RpcBridge) =>
    Layer.effect(DesktopRpcClient)(RpcClient.make(DesktopRpcs)).pipe(
      Layer.provide(RpcClient.layerProtocolSocket()),
      Layer.provide(layerIpcSocket(bridge)),
      Layer.provide(RpcSerialization.layerJson),
    );
}

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
