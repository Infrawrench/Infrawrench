/**
 * Local accounts' credentials, kept encrypted in the main process
 * (`shared/rpc/groups/local-credentials.ts`). A read decrypts (and refreshes
 * an OAuth access token about to expire) and never includes the refresh
 * token; a write asks for local-exec consent when it adds or changes a
 * kubeconfig or Docker host.
 */
import type { CredentialField } from "@infrawrench/plugin-base";
import { applyCredentialRewriters } from "./credential-rewriters";
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

/**
 * An account's credentials as a plugin client connects with them: a copy run through
 * the credential rewriters, so an account behind an SSH tunnel reaches its service
 * through the tunnel rather than this computer's own port. `credentialFields` are the
 * account's plugin's. For building a client only: never store or show what this
 * returns, since a tunnel's local port changes every time it opens.
 */
export async function localConnectionCredentials(
  accountId: string,
  credentialFields: readonly CredentialField[],
  credentials: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const connection = { ...credentials };
  await applyCredentialRewriters({ accountId, credentialFields }, connection);
  return connection;
}

/** {@link getLocalAccountCredentials}, then {@link localConnectionCredentials}. */
export async function getLocalConnectionCredentials(
  accountId: string,
  credentialFields: readonly CredentialField[],
): Promise<Record<string, string>> {
  return localConnectionCredentials(
    accountId,
    credentialFields,
    await getLocalAccountCredentials(accountId),
  );
}
