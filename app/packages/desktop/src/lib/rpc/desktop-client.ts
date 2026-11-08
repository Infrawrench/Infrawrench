/**
 * The renderer's Effect RPC client service, apart from the `window` lookup
 * and runtime in `./client.ts`, so the main process's tests can build the
 * exact client the renderer uses over a fake bridge.
 */
import { Context, Layer } from "effect";
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
