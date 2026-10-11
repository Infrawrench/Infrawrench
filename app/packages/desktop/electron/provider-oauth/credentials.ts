/**
 * Provider OAuth for accounts stored in the local SQLite workspace: the pure
 * rules (what the renderer may see, how a save treats grant state) and the
 * single-flight refresher. Storage, plugin lookup and the client id are
 * injected, so this file has no Electron, database or GUI dependency and the
 * CLI shares it unchanged.
 *
 * The main process is the only place a local account's refresh token is used.
 * The cloud never sees it (cloud-sync strips `__oauth`), and the renderer
 * receives the grant state without it (see {@link redactGrantForRenderer}).
 */
import {
  OAUTH_CREDENTIAL_KEY,
  OAuthTokenError,
  applyOAuthTokens,
  oauthNeedsRefresh,
  readOAuthGrantState,
  refreshOAuthToken,
  type OAuthDeclaration,
  type OAuthGrantState,
} from "@infrawrench/plugin-base";

export type LocalOAuthStatus = "connected" | "reconnect_required";

/** Thrown when a refresh is rejected for good: the user has to reconnect. */
export class OAuthReconnectRequiredError extends Error {
  constructor(providerName: string) {
    super(`Reconnect ${providerName}: the connection was revoked or expired.`);
    this.name = "OAuthReconnectRequiredError";
  }
}

/** Thrown when the token expired but this process may not persist a rotated refresh token. */
export class OAuthRefreshUnavailableError extends Error {
  constructor(providerName: string) {
    super(
      `The ${providerName} access token for this account has expired and its refresh ` +
        "token can only be used once, so it is refreshed by the Infrawrench app while it " +
        "is running. Use the account in the app (or quit the app) and try again.",
    );
    this.name = "OAuthRefreshUnavailableError";
  }
}

/**
 * The grant state as the renderer may see it: everything but the refresh
 * token and a dynamically registered client's secret. Plugins can still tell
 * an OAuth account from a pasted one with `readOAuthGrantState`, and the save
 * path recognises the redacted copy coming back (see
 * {@link mergeIncomingCredentials}).
 */
export function redactGrantForRenderer(
  credentials: Record<string, string>,
): Record<string, string> {
  const state = readOAuthGrantState(credentials);
  if (!state) return credentials;
  const { refreshToken: _refreshToken, clientSecret: _clientSecret, ...rest } = state;
  return { ...credentials, [OAUTH_CREDENTIAL_KEY]: JSON.stringify(rest) };
}

/**
 * True when a grant this desktop issued has expired and can never be
 * refreshed: it carries no refresh token (CircleCI's 90-day token, for
 * example). Only connecting again brings the account back.
 */
export function oauthGrantIsDead(state: OAuthGrantState, now: number = Date.now()): boolean {
  return (
    state.client === "desktop" &&
    !state.refreshToken &&
    state.expiresAt !== undefined &&
    state.expiresAt <= now
  );
}

/** `oauth_status` for a credential set about to be stored. */
export function oauthStatusFor(
  credentials: Record<string, string>,
  now: number = Date.now(),
): LocalOAuthStatus | null {
  const state = readOAuthGrantState(credentials);
  if (!state) return null;
  return oauthGrantIsDead(state, now) ? "reconnect_required" : "connected";
}

/**
 * What to store when the renderer saves an account's credentials, given what
 * is stored now. Mirrors the server's PUT rule so both hosts behave alike:
 *
 * - A fresh grant (a new connection or a reconnect, which carries a refresh
 *   token or a new `connectedAt`) is stored as sent.
 * - The redacted copy of the stored grant, or no `__oauth` at all with the
 *   token field unchanged, blank or set to a token this grant issued, keeps
 *   the stored grant and access token. Editing a picker must not disconnect,
 *   and the renderer's copy of the token may be older than a refresh.
 * - Anything else is a switch to a pasted token: the grant is dropped.
 *
 * `issuedTokens` is the set of access tokens this process has handed out for
 * the account, so a stale copy is recognised as "unchanged".
 */
export function mergeIncomingCredentials(
  incoming: Record<string, string>,
  stored: Record<string, string> | undefined,
  tokenField: string | undefined,
  issuedTokens: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const storedState = stored ? readOAuthGrantState(stored) : null;
  const incomingState = readOAuthGrantState(incoming);
  const hasIncomingKey = OAUTH_CREDENTIAL_KEY in incoming;

  if (!storedState || !stored || !tokenField) {
    // Nothing to preserve. Keep a well-formed grant; drop a malformed key.
    if (hasIncomingKey && !incomingState) {
      const { [OAUTH_CREDENTIAL_KEY]: _dropped, ...rest } = incoming;
      return rest;
    }
    return incoming;
  }

  const isRedactedStoredCopy =
    incomingState !== null &&
    incomingState.refreshToken === undefined &&
    incomingState.connectedAt === storedState.connectedAt;
  const isFreshGrant =
    incomingState !== null &&
    !isRedactedStoredCopy &&
    (incomingState.refreshToken !== undefined ||
      incomingState.connectedAt !== storedState.connectedAt);

  if (isFreshGrant) return incoming;

  const incomingToken = incoming[tokenField];
  const storedToken = stored[tokenField];
  const tokenUnchanged =
    incomingToken === undefined ||
    incomingToken === "" ||
    incomingToken === storedToken ||
    issuedTokens.has(incomingToken);

  if (isRedactedStoredCopy || (!hasIncomingKey && tokenUnchanged)) {
    return {
      ...incoming,
      ...(storedToken !== undefined ? { [tokenField]: storedToken } : {}),
      [OAUTH_CREDENTIAL_KEY]: stored[OAUTH_CREDENTIAL_KEY]!,
    };
  }

  // Switched to a pasted token (or sent a grant we cannot use).
  const { [OAUTH_CREDENTIAL_KEY]: _dropped, ...rest } = incoming;
  return rest;
}

/** Everything the refresher needs from its host. */
export interface LocalOAuthHost {
  /** The plugin's declaration and display name, or null when it declares no OAuth. */
  getProvider(
    pluginId: string,
  ): Promise<{ declaration: OAuthDeclaration; displayName: string } | null>;
  /** The build-time desktop client id. */
  getClientId(pluginId: string): string | undefined;
  /** Re-read the account's stored credentials (inside the single flight). */
  load(accountId: string): Promise<Record<string, string>>;
  /** Write refreshed credentials back. */
  save(accountId: string, credentials: Record<string, string>): Promise<void>;
  setStatus(accountId: string, status: LocalOAuthStatus): Promise<void>;
  /** False when this process opened the database read-only (CLI beside a running app). */
  canPersist(): boolean;
  fetch: typeof fetch;
  now?: () => number;
}

export interface LocalOAuthRefresher {
  /**
   * Credentials with a currently valid access token: refreshed and written
   * back when the stored one is about to expire, unchanged otherwise (and
   * always unchanged for a pasted credential).
   */
  resolve(
    accountId: string,
    pluginId: string,
    credentials: Record<string, string>,
  ): Promise<Record<string, string>>;
  /** Access tokens handed out for an account in this process (see mergeIncomingCredentials). */
  issuedTokens(accountId: string): ReadonlySet<string>;
}

const MAX_REMEMBERED_TOKENS = 8;

export function createLocalOAuthRefresher(host: LocalOAuthHost): LocalOAuthRefresher {
  const inFlight = new Map<string, Promise<Record<string, string>>>();
  const issued = new Map<string, Set<string>>();
  const now = host.now ?? Date.now;

  function remember(accountId: string, token: string | undefined): void {
    if (!token) return;
    let set = issued.get(accountId);
    if (!set) {
      set = new Set();
      issued.set(accountId, set);
    }
    set.add(token);
    if (set.size > MAX_REMEMBERED_TOKENS) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }

  async function refresh(accountId: string, pluginId: string): Promise<Record<string, string>> {
    // Re-read inside the flight: a refresh that finished a moment ago has
    // already rotated the refresh token this caller decrypted, and using the
    // old one would lock the account out.
    const credentials = await host.load(accountId);
    const state = readOAuthGrantState(credentials);
    if (!state || !needsLocalRefresh(state, now())) return credentials;

    const provider = await host.getProvider(pluginId);
    // A dynamically registered grant carries its own client id; a provider
    // without registered clients has none; otherwise the build-time id.
    const clientId =
      state.clientId ??
      (provider?.declaration.clientRegistration === "none" ? "" : host.getClientId(pluginId));
    if (!provider || clientId === undefined) {
      console.warn(
        `[provider-oauth] ${pluginId}: token is expiring but no desktop client is configured to refresh it`,
      );
      return credentials;
    }
    const { declaration, displayName } = provider;
    if (declaration.refresh === "rotating" && !host.canPersist()) {
      throw new OAuthRefreshUnavailableError(displayName);
    }

    try {
      const tokens = await refreshOAuthToken(
        declaration,
        state.refreshToken!,
        // A dynamically registered client that was issued a secret must
        // authenticate with it; every other desktop client is public.
        state.clientSecret
          ? { clientId, clientSecret: state.clientSecret, auth: "client_secret_post" }
          : { clientId, auth: "none" },
        host.fetch,
      );
      const next = { ...credentials };
      applyOAuthTokens(declaration, next, tokens, "desktop");
      await host.save(accountId, next);
      return next;
    } catch (err) {
      if (err instanceof OAuthTokenError && err.invalidGrant) {
        await host.setStatus(accountId, "reconnect_required");
        throw new OAuthReconnectRequiredError(displayName);
      }
      throw err;
    }
  }

  // Dead grants already reported, keyed by account, valued by the grant's
  // identity, so a dead token is reported once rather than on every use and a
  // reconnect (new `connectedAt`) that dies again is reported again.
  const reportedDead = new Map<string, string>();

  async function reportDead(accountId: string, state: OAuthGrantState): Promise<void> {
    const identity = `${state.connectedAt}:${state.expiresAt}`;
    if (reportedDead.get(accountId) === identity) return;
    reportedDead.set(accountId, identity);
    try {
      await host.setStatus(accountId, "reconnect_required");
    } catch (err) {
      reportedDead.delete(accountId);
      console.warn(`[provider-oauth] could not mark ${accountId} for reconnect:`, err);
    }
  }

  return {
    async resolve(accountId, pluginId, credentials) {
      const state = readOAuthGrantState(credentials);
      if (state && oauthGrantIsDead(state, now())) {
        // Nothing to refresh with. Flag the account the same way a rejected
        // refresh does, and still hand the credentials over: the editor and
        // the reconnect flow need them, and the provider's own 401 says the
        // rest to anything that calls it.
        await reportDead(accountId, state);
        return credentials;
      }
      if (!state || !needsLocalRefresh(state, now())) {
        if (state) remember(accountId, credentials[await tokenFieldOf(pluginId)]);
        return credentials;
      }
      let flight = inFlight.get(accountId);
      if (!flight) {
        flight = refresh(accountId, pluginId).finally(() => inFlight.delete(accountId));
        inFlight.set(accountId, flight);
      }
      const result = await flight;
      remember(accountId, result[await tokenFieldOf(pluginId)]);
      return result;
    },
    issuedTokens(accountId) {
      return issued.get(accountId) ?? new Set();
    },
  };

  async function tokenFieldOf(pluginId: string): Promise<string> {
    return (await host.getProvider(pluginId))?.declaration.tokenField ?? "";
  }
}

/** Only grants this desktop issued are refreshed here; anything else is left alone. */
function needsLocalRefresh(state: OAuthGrantState, now: number): boolean {
  return state.client === "desktop" && oauthNeedsRefresh(state, now);
}
