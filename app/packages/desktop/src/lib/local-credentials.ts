/**
 * Local accounts' credentials, kept encrypted in the main process
 * (`shared/rpc/groups/local-credentials.ts`). A read decrypts (and refreshes
 * an OAuth access token about to expire) and never includes the refresh
 * token; a write asks for local-exec consent when it adds or changes a
 * kubeconfig or Docker host.
 */
import { DesktopRpcClient, runRpc } from "./rpc/client";

/**
 * An account's credentials. `refresh: false` skips the OAuth refresh, for the
 * credentials editor, which must open even when the grant was revoked.
 */
export function getLocalAccountCredentials(
  accountId: string,
  options: { refresh?: boolean } = {},
): Promise<Record<string, string>> {
  return runRpc(
    DesktopRpcClient.use((rpc) =>
      rpc.LocalAccountCredentials(
        options.refresh === undefined ? { accountId } : { accountId, refresh: options.refresh },
      ),
    ),
  );
}

/** Replace an account's credentials. */
export function saveLocalAccountCredentials(
  accountId: string,
  credentials: Record<string, string>,
): Promise<void> {
  return runRpc(
    DesktopRpcClient.use((rpc) => rpc.LocalAccountSaveCredentials({ accountId, credentials })),
  );
}

/** Store a new account with its credentials. */
export function createLocalAccount(account: {
  accountId: string;
  pluginId: string;
  displayName: string;
  credentials: Record<string, string>;
}): Promise<void> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalAccountCreate(account)));
}
