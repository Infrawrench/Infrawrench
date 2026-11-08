/**
 * Local accounts' credentials for the renderer (`LocalCredentialRpcs`), as an
 * Effect service. Decrypting, the OAuth refresh and the stored grant's
 * bookkeeping are `provider-oauth/`'s; this adds what the renderer boundary
 * needs: the refresh token withheld, the local-exec consent before a new or
 * changed kubeconfig or Docker host is stored, and the SSRF allowlists
 * (kubeconfig clusters, credential endpoints) kept in step with what was
 * read or written.
 */
import { Context, Effect, Layer } from "effect";
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";
import { errorMessage } from "../shared/rpc/errors";
import { LocalCredentialsError, MAX_PLAINTEXT_BYTES } from "../shared/rpc/groups/local-credentials";
import { getSqlite, persist } from "./db";
import { registerKubeconfigClusterEndpoints } from "./k8s-endpoints";
import { registerCredentialEndpoints } from "./cors-policy";
import { approveAccountCredentials } from "./local-exec-consent";
import { buildAad, encryptValue, getEncryptionKey } from "./main-utils";
import {
  LocalAccountNotFoundError,
  getOAuthProvider,
  issuedAccessTokens,
  loadLocalAccountCredentials,
  readStoredAccount,
} from "./provider-oauth/local-accounts";
import {
  mergeIncomingCredentials,
  oauthStatusFor,
  redactGrantForRenderer,
} from "./provider-oauth/credentials";

type Credentials = Record<string, string>;

/** Keep the SSRF allowlists in step with an account's credentials. */
async function registerEndpoints(credentials: Credentials): Promise<void> {
  await registerKubeconfigClusterEndpoints(credentials["kubeconfig"]);
  registerCredentialEndpoints(credentials);
}

function encryptCredentials(accountId: string, credentials: Credentials, operation: string) {
  const plaintext = JSON.stringify(credentials);
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`${operation}: credentials too large`);
  }
  return encryptValue(plaintext, getEncryptionKey(), buildAad("account", accountId, "credentials"));
}

async function readCredentials(accountId: string, refresh: boolean): Promise<Credentials> {
  // Decrypts, and refreshes an OAuth-connected account's access token when it
  // is about to expire (provider-oauth/local-accounts.ts). Every plugin the
  // renderer runs gets its credentials here, so this covers all of them.
  let credentials: Credentials;
  try {
    credentials = refresh
      ? await loadLocalAccountCredentials(accountId)
      : (await readStoredAccount(accountId)).credentials;
  } catch (err) {
    if (err instanceof LocalAccountNotFoundError) throw new Error("Account not found");
    throw err;
  }
  // The renderer always loads an account's credentials through here before
  // talking to its cluster, so decrypt-time registration keeps the SSRF
  // allowlist populated across app restarts.
  await registerEndpoints(credentials);
  // The refresh token stays in main; the renderer gets the grant without it.
  return redactGrantForRenderer(credentials);
}

async function saveCredentials(accountId: string, incoming: Credentials): Promise<void> {
  // A kubeconfig that runs a program, or a Docker host, is local code
  // execution: a new or changed one needs consent in a native dialog before
  // it becomes a stored value the connect-time gate trusts (local-exec-guard.ts).
  const stored = await readStoredAccount(accountId).catch(() => undefined);
  const previous = stored?.credentials;
  // Provider OAuth: keep the stored grant across picker edits, take a fresh
  // one from a reconnect, drop it when the user pastes a token instead.
  const tokenField =
    stored && (OAUTH_CREDENTIAL_KEY in incoming || (previous && OAUTH_CREDENTIAL_KEY in previous))
      ? (await getOAuthProvider(stored.pluginId))?.declaration.tokenField
      : undefined;
  const credentials = mergeIncomingCredentials(
    incoming,
    previous,
    tokenField,
    issuedAccessTokens(accountId),
  );
  const { ciphertext, iv } = encryptCredentials(accountId, credentials, "account_save_credentials");
  await approveAccountCredentials(credentials, previous);
  const db = await getSqlite();
  db.run(
    "UPDATE accounts SET encrypted_credentials = ?, credentials_iv = ?, oauth_status = ? WHERE id = ?",
    [ciphertext, iv, oauthStatusFor(credentials), accountId],
  );
  if (db.getRowsModified() === 0) throw new Error("Account not found");
  persist();
  await registerEndpoints(credentials);
}

interface NewAccount {
  readonly accountId: string;
  readonly pluginId: string;
  readonly displayName: string;
  readonly credentials: Credentials;
}

async function createAccount(account: NewAccount): Promise<void> {
  const { accountId, pluginId, displayName } = account;
  // Drops a malformed `__oauth`; keeps a grant from `ProviderOAuthConnect`.
  const credentials = mergeIncomingCredentials(account.credentials, undefined, undefined);
  const { ciphertext, iv } = encryptCredentials(accountId, credentials, "account_create");
  await approveAccountCredentials(credentials, undefined);
  const db = await getSqlite();
  db.run(
    `INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv, oauth_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [accountId, pluginId, displayName, ciphertext, iv, oauthStatusFor(credentials)],
  );
  persist();
  await registerEndpoints(credentials);
}

const toCredentialsError = (cause: unknown) =>
  new LocalCredentialsError({ message: errorMessage(cause) });

export class LocalCredentials extends Context.Service<
  LocalCredentials,
  {
    readonly read: (
      accountId: string,
      refresh: boolean,
    ) => Effect.Effect<Credentials, LocalCredentialsError>;
    readonly save: (
      accountId: string,
      credentials: Credentials,
    ) => Effect.Effect<void, LocalCredentialsError>;
    readonly create: (account: NewAccount) => Effect.Effect<void, LocalCredentialsError>;
  }
>()("infrawrench/desktop/LocalCredentials") {
  static readonly layer = Layer.succeed(LocalCredentials)(
    LocalCredentials.of({
      read: (accountId, refresh) =>
        Effect.tryPromise({
          try: () => readCredentials(accountId, refresh),
          catch: toCredentialsError,
        }),
      save: (accountId, credentials) =>
        Effect.tryPromise({
          try: () => saveCredentials(accountId, credentials),
          catch: toCredentialsError,
        }),
      create: (account) =>
        Effect.tryPromise({ try: () => createAccount(account), catch: toCredentialsError }),
    }),
  );
}
