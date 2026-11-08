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
import { AppShellHandlers } from "./handlers/app-shell";
import { K8sLocalHandlers } from "./handlers/k8s-local";
import { LocalDatabaseHandlers } from "./handlers/local-database";
import { LocalCredentialHandlers, LocalSecretHandlers } from "./handlers/local-secrets";
import { LocalDeployHistoryHandlers } from "./handlers/deploy-history";
import { LocalDnsHandlers } from "./handlers/local-dns";
import { LocalEnvironmentDiffHandlers } from "./handlers/local-environment-diff";
import { LocalExpiringHandlers } from "./handlers/local-expiring";
import { LocalExtendedSupportHandlers } from "./handlers/local-extended-support";
import { LocalOrphansHandlers } from "./handlers/local-orphans";
import { LocalPostureHandlers } from "./handlers/local-posture";
import { ShellCommandHandlers } from "./handlers/shell-command";
import { SshHandlers } from "./handlers/ssh";
import { CloudAuthHandlers, CloudSshKeyHandlers } from "./handlers/cloud-auth";
import { CloudHttpHandlers } from "./handlers/cloud-http";
import { DeepLinkHandlers } from "./handlers/deep-links";
import { InstancePricingHandlers } from "./handlers/instance-pricing";
import { K8sPfCloudHandlers } from "./handlers/k8s-pf-cloud";
import { LinuxAppsHandlers } from "./handlers/linux-apps";
import { PluginDriverHandlers } from "./handlers/plugin-drivers";
import { ProviderOAuthHandlers } from "./handlers/provider-oauth";
import { WorkflowHandlers } from "./handlers/workflows";

const DesktopRpcHandlers = Layer.mergeAll(
  ShellCommandHandlers,
  AppShellHandlers,
  K8sLocalHandlers,
  LocalCredentialHandlers,
  LocalDatabaseHandlers,
  LocalSecretHandlers,
  LocalDeployHistoryHandlers,
  LocalDnsHandlers,
  LocalEnvironmentDiffHandlers,
  LocalExpiringHandlers,
  LocalExtendedSupportHandlers,
  LocalOrphansHandlers,
  LocalPostureHandlers,
  SshHandlers,
  CloudAuthHandlers,
  CloudSshKeyHandlers,
  CloudHttpHandlers,
  DeepLinkHandlers,
  InstancePricingHandlers,
  K8sPfCloudHandlers,
  LinuxAppsHandlers,
  PluginDriverHandlers,
  ProviderOAuthHandlers,
  WorkflowHandlers,
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
