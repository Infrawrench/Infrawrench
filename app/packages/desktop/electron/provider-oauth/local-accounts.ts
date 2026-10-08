/**
 * Decrypting a local account's credentials, with provider OAuth applied: the
 * one path every main-process decrypt site goes through (the
 * `account_get_credentials` IPC, `plugin-runtime.ts`, the CLI's
 * `infrafile/plugin-host.ts`). An OAuth-connected account comes back with a
 * valid access token, refreshed and written back here when it was about to
 * expire; a pasted credential comes back exactly as stored.
 *
 * No GUI side effects: the CLI imports this. The GUI learns about status
 * changes through {@link setOAuthStatusListener}.
 */
import type { OAuthDeclaration } from "@infrawrench/plugin-base";
import { getSqlite, isDatabaseReadOnly, persist } from "../db";
import { buildAad, decryptValue, encryptValue, getEncryptionKey } from "../main-utils";
import { getDesktopOAuthClientId } from "./build-env";
import { createLocalOAuthRefresher, type LocalOAuthStatus } from "./credentials";

/** Thrown when the account row does not exist. */
export class LocalAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} not found in the local workspace.`);
    this.name = "LocalAccountNotFoundError";
  }
}

interface StoredAccount {
  pluginId: string;
  credentials: Record<string, string>;
}

/** Decrypt the stored row as is, with no refresh. */
export async function readStoredAccount(accountId: string): Promise<StoredAccount> {
  const db = await getSqlite();
  const stmt = db.prepare(
    "SELECT plugin_id, encrypted_credentials, credentials_iv FROM accounts WHERE id = ? LIMIT 1",
  );
  stmt.bind([accountId]);
  const row = stmt.step() ? (stmt.getAsObject() as Record<string, unknown>) : null;
  stmt.free();
  if (!row) throw new LocalAccountNotFoundError(accountId);
  const plaintext = decryptValue(
    String(row["encrypted_credentials"] ?? ""),
    String(row["credentials_iv"] ?? ""),
    getEncryptionKey(),
    buildAad("account", accountId, "credentials"),
  );
  return {
    pluginId: String(row["plugin_id"] ?? ""),
    credentials: JSON.parse(plaintext) as Record<string, string>,
  };
}

/**
 * Encrypt and store refreshed credentials. Deliberately leaves `updated_at`
 * alone: a token refresh is not a user edit, and bumping it would make
 * cloud-sync push the account every hour.
 */
async function writeRefreshedCredentials(
  accountId: string,
  credentials: Record<string, string>,
): Promise<void> {
  const aad = buildAad("account", accountId, "credentials");
  const { ciphertext, iv } = encryptValue(JSON.stringify(credentials), getEncryptionKey(), aad);
  const db = await getSqlite();
  db.run(
    "UPDATE accounts SET encrypted_credentials = ?, credentials_iv = ?, oauth_status = 'connected' WHERE id = ?",
    [ciphertext, iv, accountId],
  );
  persist();
}

type StatusListener = (accountId: string, status: LocalOAuthStatus) => void;
let statusListener: StatusListener | null = null;

/** The GUI registers this to tell windows an account needs reconnecting. */
export function setOAuthStatusListener(listener: StatusListener | null): void {
  statusListener = listener;
}

async function writeStatus(accountId: string, status: LocalOAuthStatus): Promise<void> {
  const db = await getSqlite();
  // Only a real change is written and announced, so a dead grant met again
  // after a restart does not re-notify every window.
  db.run("UPDATE accounts SET oauth_status = ? WHERE id = ? AND oauth_status IS NOT ?", [
    status,
    accountId,
    status,
  ]);
  if (db.getRowsModified() === 0) return;
  persist();
  statusListener?.(accountId, status);
}

/** The plugin's OAuth declaration, loaded lazily (only OAuth accounts pay for the registry). */
export async function getOAuthProvider(
  pluginId: string,
): Promise<{ declaration: OAuthDeclaration; displayName: string } | null> {
  const { getPlugin } = await import("../infrafile/plugins.js");
  const loaded = await getPlugin(pluginId);
  const declaration = loaded?.plugin.manifest.oauth;
  if (!loaded || !declaration) return null;
  return { declaration, displayName: loaded.plugin.manifest.displayName };
}

const refresher = createLocalOAuthRefresher({
  getProvider: getOAuthProvider,
  getClientId: getDesktopOAuthClientId,
  load: async (accountId) => (await readStoredAccount(accountId)).credentials,
  save: writeRefreshedCredentials,
  setStatus: writeStatus,
  canPersist: () => !isDatabaseReadOnly(),
  fetch: (input, init) => fetch(input, init),
});

/**
 * A local account's credentials, ready for a plugin: decrypted, and for an
 * OAuth connection refreshed when needed. Grant state (`__oauth`) is
 * included; strip or redact it before it leaves the main process.
 */
export async function loadLocalAccountCredentials(
  accountId: string,
): Promise<Record<string, string>> {
  const { pluginId, credentials } = await readStoredAccount(accountId);
  return refresher.resolve(accountId, pluginId, credentials);
}

/** Access tokens this process handed out for the account (for the save rule). */
export function issuedAccessTokens(accountId: string): ReadonlySet<string> {
  return refresher.issuedTokens(accountId);
}
