import { DesktopRpcClient, runRpc } from "./rpc/client";
import type { LocalDeployRun } from "./deploy-history-types";

export type { LocalDeployRun };

/**
 * What `infrawrench deploy` did on this machine, newest first.
 *
 * Read-only: only the CLI deploys locally, so only the CLI writes the history
 * (see `electron/deploy-history.ts` for why it is a file, not a table).
 */
export function listLocalDeploys(): Promise<LocalDeployRun[]> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalDeployHistory()));
}
