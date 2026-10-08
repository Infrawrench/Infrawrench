/**
 * Provider OAuth ("Connect with X"): the declaration a plugin puts on its
 * manifest, the hooks it may implement, and the generic, dependency-free
 * protocol helpers every host shares (authorize URL, PKCE, code exchange,
 * refresh, and the reserved credential key that carries grant state).
 *
 * An OAuth connection is an ordinary credential set: the access token lands in
 * the plugin's existing token field (`OAuthDeclaration.tokenField`), so the
 * plugin's client reads it exactly as it reads a pasted token. The refresh
 * token and expiry live beside it under {@link OAUTH_CREDENTIAL_KEY} as a JSON
 * string, which the host owns: it refreshes the access token before handing
 * credentials to the plugin and persists whatever the provider rotated. An
 * account without that key is a pasted credential and the host leaves it
 * alone, so manual entry keeps working for every OAuth-capable plugin.
 *
 * Everything here uses only `fetch`, `crypto.getRandomValues` and
 * `crypto.subtle`, so it runs in Node, the Electron main process and a
 * Cloudflare Worker alike.
 */

/** Reserved credential key holding the serialized {@link OAuthGrantState}. */
export const OAUTH_CREDENTIAL_KEY = "__oauth";

/**
 * Which client performs the flow.
 *
 * - `server`: the hosted web API's confidential client (holds a client
 *   secret). Used by the web app and by the desktop app in cloud mode.
 * - `desktop`: the desktop app's public client (no secret, PKCE, loopback
 *   redirect). Used only for accounts stored locally on the desktop.
 */
export type OAuthClientKind = "server" | "desktop";

/** How the token endpoint authenticates the client. */
export type OAuthClientAuthMethod = "client_secret_post" | "client_secret_basic" | "none";

export interface OAuthServerClientDeclaration {
  /**
   * How the client secret is sent to the token endpoint. Default
   * `client_secret_post`. `none` is a public web client (PKCE, no secret):
   * the host then needs only the client id, and must send no secret, since
   * some providers reject a request that carries one.
   */
  auth?: OAuthClientAuthMethod;
  /** Also send a PKCE S256 challenge. Harmless where unsupported; set it where documented. */
  pkce?: boolean;
}

export interface OAuthDesktopClientDeclaration {
  /**
   * Loopback host the provider accepts for a native app's redirect. Some
   * providers only accept `127.0.0.1` (RFC 8252), others only `localhost`.
   * Default `127.0.0.1`. The desktop listens on a fixed port and path:
   * `http://<host>:43118/oauth/callback`, which is what to register.
   */
  loopbackHost?: "127.0.0.1" | "localhost";
}

/**
 * Declarative description of a provider's OAuth flow. Pure data, so the web
 * edge Worker (which carries manifests but no plugin code) can read it.
 */
export interface OAuthDeclaration {
  /** Provider's authorization endpoint. */
  authorizeUrl: string;
  /** Provider's token endpoint (code exchange and refresh). */
  tokenUrl: string;
  /** Scopes to request. Empty when the provider configures scopes on the app itself. */
  scopes: string[];
  /** Joiner for `scopes` in the authorize URL. Default a single space. */
  scopeSeparator?: string;
  /** Extra static query parameters for the authorize URL (e.g. `prompt=consent`). */
  authorizeParams?: Record<string, string>;
  /** Credential key that receives the access token, e.g. `apiToken`. */
  tokenField: string;
  /**
   * Which clients exist. A plugin with only `server` is server-only: the
   * desktop hides the button for local accounts. A plugin with only
   * `desktop` cannot be connected from the web app.
   */
  clients: {
    server?: OAuthServerClientDeclaration;
    desktop?: OAuthDesktopClientDeclaration;
  };
  /**
   * What the granted token can do. `full` means the provider offers no
   * narrower scope, and the UI says so before the user consents.
   */
  access: "read-only" | "read-write" | "full";
  /**
   * Refresh behavior. `rotating`: every refresh returns a new refresh token
   * and invalidates the old one, so a refresh must be persisted atomically.
   * `reusable`: the refresh token survives a refresh. `none`: the access
   * token is long-lived (or the flow mints an API key) and is never refreshed.
   */
  refresh: "rotating" | "reusable" | "none";
  /** Provider docs page explaining the consent/app, linked from the UI. */
  docsUrl?: string;
  /**
   * How the host obtains a client id. `static` (default): from env
   * (`oauthEnvPrefix`). `none`: the provider needs no registered client (the
   * flow is identified by its callback URL), so the flow is available with no
   * configuration. `dynamic`: the plugin registers a client per flow through
   * {@link OAuthPluginHooks.registerOAuthClient} before building the
   * authorize URL.
   */
  clientRegistration?: "static" | "none" | "dynamic";
}

/** Host-owned grant state stored (JSON-encoded) under {@link OAUTH_CREDENTIAL_KEY}. */
export interface OAuthGrantState {
  v: 1;
  /** Which client issued the grant: refresh must use the same one. */
  client: OAuthClientKind;
  refreshToken?: string;
  /** Epoch milliseconds the access token expires at; absent when it does not expire. */
  expiresAt?: number;
  /** Space-separated scopes the provider reports as granted. */
  scope?: string;
  /** Epoch milliseconds the grant was first obtained. */
  connectedAt: number;
  /** Client id a dynamically registered grant must refresh with. */
  clientId?: string;
}

/** A token endpoint response, normalized. `raw` keeps provider-specific extras. */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  raw: Record<string, unknown>;
}

/** Client identity handed to the exchange/refresh helpers. */
export interface OAuthClientCredentials {
  clientId: string;
  clientSecret?: string;
  auth: OAuthClientAuthMethod;
}

/** Context passed to {@link OAuthPluginHooks.completeOAuthConnection}. */
export interface OAuthCompletionContext {
  client: OAuthClientKind;
  /** Host fetch (bastion/egress aware on the server). */
  fetch: typeof fetch;
}

/** What a plugin returns after a successful exchange. */
export interface OAuthCompletionResult {
  /**
   * Extra credential values to pre-fill (an account id, an org slug, a
   * region), keyed by credential field key. The token field is filled by
   * the host and must not be returned here. The user still sees the form and
   * can change any picker before saving.
   */
  credentials?: Record<string, string>;
  /** Suggested account display name, e.g. the provider account's name or email. */
  accountName?: string;
}

/** Arguments to a plugin's custom code exchange. */
export interface OAuthExchangeRequest {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  client: OAuthClientCredentials;
  fetch: typeof fetch;
}

/**
 * Optional plugin hooks, declared on `Plugin` (functions, so the web edge
 * Worker sees them as gateway-only stubs; the routes calling them run on the
 * gateway).
 */
export interface OAuthPluginHooks {
  /**
   * Read the connected identity after a successful exchange: which account or
   * org the token covers, and a friendly name. Optional.
   */
  completeOAuthConnection?(
    tokens: OAuthTokenSet,
    context: OAuthCompletionContext,
  ): Promise<OAuthCompletionResult>;
  /**
   * Replace the standard RFC 6749 code exchange, for providers whose token
   * call is non-standard (a JSON body, a key-minting endpoint). Optional.
   */
  exchangeOAuthCode?(request: OAuthExchangeRequest): Promise<OAuthTokenSet>;
  /**
   * Replace the standard authorize URL, for providers whose consent page
   * takes non-standard parameters (`callback_url` instead of `redirect_uri`,
   * no client id). When present the host calls it instead of
   * {@link buildOAuthAuthorizeUrl}. Pure and synchronous.
   */
  buildOAuthAuthorizeUrl?(params: OAuthAuthorizeUrlParams): string;
  /**
   * Register a client for one flow (RFC 7591 dynamic client registration).
   * Required when `manifest.oauth.clientRegistration === "dynamic"`; the host
   * calls it with the redirect URI before building the authorize URL and
   * uses the returned client for the exchange and later refreshes (the
   * client id is kept in the grant state as `clientId`).
   */
  registerOAuthClient?(request: {
    redirectUri: string;
    fetch: typeof fetch;
  }): Promise<{ clientId: string; clientSecret?: string }>;
}

/** Parameters for building an authorize URL. `clientId` is empty for `clientRegistration: "none"`. */
export interface OAuthAuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

/**
 * Host service handed to an OAuth-connected account's client
 * (`HostServices.oauth`). Present only when the account's credentials carry
 * grant state. A plugin whose provider issues very short-lived access tokens
 * can call it before a request to get a token that is valid right now; the
 * host refreshes (and persists the rotation) when needed. Most plugins never
 * need it: the host already refreshes before building the client.
 */
export interface OAuthHostServices {
  /** A currently valid access token, refreshed by the host if it was about to expire. */
  getAccessToken(): Promise<string>;
}

/** Fixed desktop loopback port for provider OAuth (the CLI's sign-in uses 43117). */
export const DESKTOP_OAUTH_LOOPBACK_PORT = 43118;
export const DESKTOP_OAUTH_LOOPBACK_PATH = "/oauth/callback";

/** The redirect URI the desktop registers and listens on for a declaration. */
export function desktopOAuthRedirectUri(declaration: OAuthDeclaration): string {
  const host = declaration.clients.desktop?.loopbackHost ?? "127.0.0.1";
  return `http://${host}:${DESKTOP_OAUTH_LOOPBACK_PORT}${DESKTOP_OAUTH_LOOPBACK_PATH}`;
}

/**
 * Environment variable names for a plugin's client ids. Server:
 * `PROVIDER_OAUTH_<ID>_CLIENT_ID` / `_CLIENT_SECRET`; desktop build:
 * `MAIN_VITE_PROVIDER_OAUTH_<ID>_CLIENT_ID`. `<ID>` is the plugin id upper-cased
 * with non-alphanumerics as `_` (`hugging-face` → `HUGGING_FACE`).
 */
export function oauthEnvPrefix(pluginId: string): string {
  return `PROVIDER_OAUTH_${pluginId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random URL-safe string (state values, nonces). */
export function randomOAuthToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** A PKCE verifier and its S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomOAuthToken(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** Build the provider authorize URL. */
export function buildOAuthAuthorizeUrl(
  declaration: OAuthDeclaration,
  params: OAuthAuthorizeUrlParams,
): string {
  const url = new URL(declaration.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  if (declaration.scopes.length > 0) {
    url.searchParams.set("scope", declaration.scopes.join(declaration.scopeSeparator ?? " "));
  }
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(declaration.authorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/** Error from a token endpoint. `invalidGrant` means the user must reconnect. */
export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly invalidGrant: boolean,
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

/** Normalize a token endpoint JSON body. Exported for custom exchanges. */
export function parseOAuthTokenResponse(
  body: Record<string, unknown>,
  now: number = Date.now(),
): OAuthTokenSet {
  const accessToken = body["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthTokenError("The provider's token response had no access token.", 200, false);
  }
  const expiresIn = Number(body["expires_in"]);
  const refreshToken = body["refresh_token"];
  const scope = body["scope"];
  const tokenType = body["token_type"];
  return {
    accessToken,
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(typeof scope === "string"
      ? { scope }
      : Array.isArray(scope)
        ? { scope: scope.join(" ") }
        : {}),
    ...(typeof tokenType === "string" ? { tokenType } : {}),
    raw: body,
  };
}

async function postTokenEndpoint(
  tokenUrl: string,
  form: Record<string, string>,
  client: OAuthClientCredentials,
  doFetch: typeof fetch,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (client.auth === "client_secret_basic") {
    headers["Authorization"] =
      `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret ?? "")}`)}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.auth === "client_secret_post" && client.clientSecret) {
      body.set("client_secret", client.clientSecret);
    }
  }
  const res = await doFetch(tokenUrl, { method: "POST", headers, body: body.toString() });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some providers answer errors as form-encoded or plain text.
    for (const [k, v] of new URLSearchParams(text)) json[k] = v;
  }
  const error = typeof json["error"] === "string" ? json["error"] : undefined;
  if (!res.ok || error) {
    const description =
      typeof json["error_description"] === "string" ? json["error_description"] : undefined;
    throw new OAuthTokenError(
      description ?? error ?? `Token endpoint returned HTTP ${res.status}`,
      res.status,
      // GitHub reports a dead refresh token as HTTP 200 with `bad_refresh_token`.
      error === "invalid_grant" ||
        error === "invalid_token" ||
        error === "unauthorized_client" ||
        error === "bad_refresh_token",
    );
  }
  return parseOAuthTokenResponse(json);
}

/** Standard authorization-code exchange. */
export function exchangeOAuthCode(
  declaration: OAuthDeclaration,
  request: OAuthExchangeRequest,
): Promise<OAuthTokenSet> {
  return postTokenEndpoint(
    declaration.tokenUrl,
    {
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      ...(request.codeVerifier ? { code_verifier: request.codeVerifier } : {}),
    },
    request.client,
    request.fetch,
  );
}

/** Standard refresh-token grant. */
export function refreshOAuthToken(
  declaration: OAuthDeclaration,
  refreshToken: string,
  client: OAuthClientCredentials,
  doFetch: typeof fetch = fetch,
): Promise<OAuthTokenSet> {
  return postTokenEndpoint(
    declaration.tokenUrl,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    client,
    doFetch,
  );
}

/** Parse the grant state out of a credential set, or null for a pasted credential. */
export function readOAuthGrantState(credentials: Record<string, string>): OAuthGrantState | null {
  const raw = credentials[OAUTH_CREDENTIAL_KEY];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OAuthGrantState;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Grant state for a fresh token set. */
export function grantStateFromTokens(
  tokens: OAuthTokenSet,
  client: OAuthClientKind,
  previous?: OAuthGrantState | null,
): OAuthGrantState {
  const refreshToken = tokens.refreshToken ?? previous?.refreshToken;
  const scope = tokens.scope ?? previous?.scope;
  return {
    v: 1,
    client,
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(scope ? { scope } : {}),
    connectedAt: previous?.connectedAt ?? Date.now(),
    ...(previous?.clientId ? { clientId: previous.clientId } : {}),
  };
}

/** Write a token set into a credential set in place (token field + grant state). */
export function applyOAuthTokens(
  declaration: OAuthDeclaration,
  credentials: Record<string, string>,
  tokens: OAuthTokenSet,
  client: OAuthClientKind,
): void {
  const previous = readOAuthGrantState(credentials);
  credentials[declaration.tokenField] = tokens.accessToken;
  credentials[OAUTH_CREDENTIAL_KEY] = JSON.stringify(
    grantStateFromTokens(tokens, client, previous),
  );
}

/** Refresh this long before expiry, so a client built now outlives a short request. */
export const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** True when the stored access token is expired or about to be and can be refreshed. */
export function oauthNeedsRefresh(state: OAuthGrantState, now: number = Date.now()): boolean {
  if (!state.refreshToken || state.expiresAt === undefined) return false;
  return state.expiresAt - now <= OAUTH_REFRESH_MARGIN_MS;
}

/** Remove the grant state (e.g. before handing credentials to a browser or another host). */
export function stripOAuthGrantState(credentials: Record<string, string>): Record<string, string> {
  const { [OAUTH_CREDENTIAL_KEY]: _omitted, ...rest } = credentials;
  return rest;
}
