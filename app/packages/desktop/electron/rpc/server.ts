/**
 * The desktop main process's Effect RPC server: every group in
 * `shared/rpc/groups`, served to the renderer over Electron IPC
 * (`./ipc-socket-server.ts`) with JSON frames.
 *
 * {@link startRpcServer} is called once from `main.ts`, before the first
 * window loads; the server lives for the life of the process.
 */
import { Effect, Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { DesktopRpcs } from "../../shared/rpc/groups";
import { layerIpcSocketServer } from "./ipc-socket-server";
import { LocalDeployHistoryHandlers } from "./handlers/deploy-history";
import { LocalDnsHandlers } from "./handlers/local-dns";
import { LocalEnvironmentDiffHandlers } from "./handlers/local-environment-diff";
import { LocalExpiringHandlers } from "./handlers/local-expiring";
import { LocalExtendedSupportHandlers } from "./handlers/local-extended-support";
import { LocalOrphansHandlers } from "./handlers/local-orphans";
import { LocalPostureHandlers } from "./handlers/local-posture";
import { ShellCommandHandlers } from "./handlers/shell-command";
import { SshHandlers } from "./handlers/ssh";

const DesktopRpcHandlers = Layer.mergeAll(
  ShellCommandHandlers,
  LocalDeployHistoryHandlers,
  LocalDnsHandlers,
  LocalEnvironmentDiffHandlers,
  LocalExpiringHandlers,
  LocalExtendedSupportHandlers,
  LocalOrphansHandlers,
  LocalPostureHandlers,
  SshHandlers,
);

export const RpcServerLive = RpcServer.layer(DesktopRpcs).pipe(
  Layer.provide(DesktopRpcHandlers),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(layerIpcSocketServer),
  Layer.provide(RpcSerialization.layerJson),
);

/** Start serving; the returned fiber runs until the process exits. */
export function startRpcServer() {
  return Effect.runFork(Layer.launch(RpcServerLive));
}
