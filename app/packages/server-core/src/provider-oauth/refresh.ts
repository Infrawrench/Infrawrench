/**
 * Refreshing an OAuth-connected account's access token where the account is
 * stored: here, for cloud (Postgres) accounts.
 *
 * Providers with rotating refresh tokens invalidate the old one on every
 * refresh, so two concurrent refreshes of one account lock it out. Two layers
 * prevent that:
 *
 * - an in-process single-flight map, so concurrent callers in this process
 *   (or edge isolate) share one refresh;
 * - a row lock (`SELECT ... FOR UPDATE`) across processes: inside it the
 *   credentials are decrypted again and the need for a refresh re-checked, so
 *   a caller that waited behind another process's refresh finds the new
 *   token and does nothing.
 *
 * The refreshed token and rotated refresh token are written back in the same
 * transaction. A refresh the provider refuses with `invalid_grant` marks the
 * account `reconnect_required` and throws {@link OAuthReconnectRequiredError}.
 */
import { and, eq } from "drizzle-orm";
import {
  OAuthTokenError,
  applyOAuthTokens,
  oauthNeedsRefresh,
  readOAuthGrantState,
  refreshOAuthToken,
  type PluginManifest,
} from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accounts } from "../db/schema";
import { buildAad, decrypt, encrypt } from "../encryption";
import { serverClientCredentials, serverOAuthClient } from "./config";

/** The connection was revoked or its refresh token expired: the user must reconnect. */
export class OAuthReconnectRequiredError extends Error {
  constructor(readonly providerName: string) {
    super(`Reconnect ${providerName}: the connection was revoked or expired.`);
    this.name = "OAuthReconnectRequiredError";
  }
}

/**
 * Where account credentials are read and written under a lock. The default is
 * Postgres; tests substitute a fake.
 */
export interface AccountCredentialStore {
  /**
   * Run `fn` with the account's current decrypted credentials while holding
   * an exclusive lock on its row. When `fn` returns credentials they are
   * encrypted and written back (with `oauthStatus`) before the lock is
   * released. Returns null when the account does not exist.
   */
  withLockedCredentials<T>(
    accountId: string,
    organizationId: string,
    fn: (credentials: Record<string, string>) => Promise<{
      result: T;
      write?: { credentials: Record<string, string>; oauthStatus?: string | null };
    }>,
  ): Promise<T | null>;
  /** Set `accounts.oauth_status` outside any lock. */
  setOAuthStatus(accountId: string, organizationId: string, status: string | null): Promise<void>;
}

export const postgresCredentialStore: AccountCredentialStore = {
  async withLockedCredentials(accountId, organizationId, fn) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          encryptedCredentials: accounts.encryptedCredentials,
          credentialsIv: accounts.credentialsIv,
        })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
        .for("update");
      if (!row) return null;
      const aad = buildAad("account", accountId, "credentials");
      const credentials = JSON.parse(
        await decrypt(row.encryptedCredentials, row.credentialsIv, aad),
      ) as Record<string, string>;
      const { result, write } = await fn(credentials);
      if (write) {
        const { ciphertext, iv } = await encrypt(JSON.stringify(write.credentials), aad);
        await tx
          .update(accounts)
          .set({
            encryptedCredentials: ciphertext,
            credentialsIv: iv,
            ...(write.oauthStatus !== undefined ? { oauthStatus: write.oauthStatus } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
      }
      return result;
    });
  },
  async setOAuthStatus(accountId, organizationId, status) {
    await db
      .update(accounts)
      .set({ oauthStatus: status })
      .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  },
};

/**
 * Read-modify-write an account's credentials under its row lock, so the
 * change cannot race a token refresh and drop a rotated refresh token.
 * Returns the stored credentials, or null when the account does not exist.
 */
export function updateAccountCredentials(
  accountId: string,
  organizationId: string,
  mutate: (credentials: Record<string, string>) => Record<string, string>,
  store: AccountCredentialStore = postgresCredentialStore,
): Promise<Record<string, string> | null> {
  return store.withLockedCredentials(accountId, organizationId, async (current) => {
    const next = mutate({ ...current });
    return { result: next, write: { credentials: next } };
  });
}

export interface ResolveOAuthOptions {
  accountId: string;
  organizationId: string;
  manifest: PluginManifest;
  credentials: Record<string, string>;
  store?: AccountCredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
}

const inflight = new Map<string, Promise<Record<string, string>>>();

/**
 * Credentials with a valid access token. A pasted credential (no grant
 * state), a grant that does not expire, or one issued to another client
 * comes back unchanged; an expiring server grant is refreshed and persisted
 * first. Always returns a fresh object the caller may mutate.
 */
export async function resolveOAuthCredentials(
  options: ResolveOAuthOptions,
): Promise<Record<string, string>> {
  const { accountId, organizationId, manifest, credentials } = options;
  const declaration = manifest.oauth;
  const state = readOAuthGrantState(credentials);
  const now = options.now ?? Date.now;
  if (!declaration || !state || state.client !== "server" || !oauthNeedsRefresh(state, now())) {
    return { ...credentials };
  }

  const key = `${organizationId}:${accountId}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = refreshUnderLock(options).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return { ...(await pending) };
}

async function refreshUnderLock(options: ResolveOAuthOptions): Promise<Record<string, string>> {
  const { accountId, organizationId, manifest } = options;
  const declaration = manifest.oauth!;
  const store = options.store ?? postgresCredentialStore;
  const now = options.now ?? Date.now;
  let reconnect = false;

  const refreshed = await store.withLockedCredentials(
    accountId,
    organizationId,
    async (current) => {
      const state = readOAuthGrantState(current);
      // Another process refreshed while this one waited for the lock, or the
      // grant was replaced in the meantime: use what is stored.
      if (!state || state.client !== "server" || !oauthNeedsRefresh(state, now())) {
        return { result: current };
      }
      const client = serverOAuthClient(manifest.id);
      if (!client) {
        throw new Error(
          `${manifest.displayName} OAuth is not configured on this server, so its connection cannot be refreshed.`,
        );
      }
      try {
        const tokens = await refreshOAuthToken(
          declaration,
          state.refreshToken!,
          serverClientCredentials(declaration, client),
          options.fetch ?? fetch,
        );
        const next = { ...current };
        applyOAuthTokens(declaration, next, tokens, "server");
        return { result: next, write: { credentials: next, oauthStatus: "connected" } };
      } catch (e) {
        if (e instanceof OAuthTokenError && e.invalidGrant) {
          reconnect = true;
          return { result: current };
        }
        throw e;
      }
    },
  );

  if (reconnect) {
    await store.setOAuthStatus(accountId, organizationId, "reconnect_required");
    throw new OAuthReconnectRequiredError(manifest.displayName);
  }
  if (!refreshed) throw new Error("Account not found");
  return refreshed;
}

/**
 * The account's stored credentials, refreshed if needed. Backs the `oauth`
 * host service, which must see a rotation that happened after the client was
 * built rather than the snapshot it was built from.
 */
export async function freshAccountCredentials(
  accountId: string,
  organizationId: string,
  manifest: PluginManifest,
): Promise<Record<string, string>> {
  const [row] = await db
    .select({
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new Error("Account not found");
  const credentials = JSON.parse(
    await decrypt(
      row.encryptedCredentials,
      row.credentialsIv,
      buildAad("account", accountId, "credentials"),
    ),
  ) as Record<string, string>;
  return resolveOAuthCredentials({ accountId, organizationId, manifest, credentials });
}

/** Test hook: forget in-flight refreshes. */
export function resetOAuthRefreshStateForTests(): void {
  inflight.clear();
}
