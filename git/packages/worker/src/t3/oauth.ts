/**
 * The forge as an OAuth client of a T3 Code environment's MCP server, the
 * way the MCP authorization specification (2025-11-25) has a client do it:
 *
 * 1. **Discovery.** The protected resource's metadata (RFC 9728), from the
 *    `resource_metadata` of the `401` an unauthenticated call gets, else the
 *    well-known addresses. It names the authorization server, whose own
 *    metadata (RFC 8414, or OpenID Connect discovery) names the endpoints.
 * 2. **Registration.** Dynamic client registration (RFC 7591), as a public
 *    client: there is no client id or secret to configure anywhere.
 * 3. **Authorization code with PKCE (`S256`)** and the `resource` indicator
 *    (RFC 8707). A server whose metadata does not list `S256` is refused.
 * 4. **Refresh and revocation** (RFC 7009), where the server has them. T3
 *    Code 0.1 has neither: a sign-in is one access token that lasts thirty
 *    days, and it ends there or when the person removes this site in T3 Code.
 *
 * Every address in those documents is one a server chose, so each goes
 * through the guarded fetch (`./http.ts`): public `https:` only, no
 * redirects, bounded. Nothing here stores anything; `./environments.ts`
 * does.
 */
import { T3Error, type T3Http, jsonObject, publicHttpsUrl } from "./http";

/** Where an environment's MCP server is, under its origin. */
export const MCP_PATH = "/mcp";

export interface OAuthEndpoints {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly revocationEndpoint?: string;
}

export interface Discovered {
  readonly endpoints: OAuthEndpoints;
  /** The resource indicator: what the token is for. */
  readonly resource: string;
  /** Scopes to ask for: the challenge's, else the resource's. Empty: ask for none. */
  readonly scopes: readonly string[];
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

/** `resource_metadata` and `scope` out of a `WWW-Authenticate: Bearer ...` challenge. */
export const parseChallenge = (
  header: string | null,
): { resourceMetadata?: string; scope?: string } => {
  if (header === null || !/^\s*bearer\b/i.test(header)) return {};
  const found: Record<string, string> = {};
  for (const match of header.matchAll(/([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) {
    found[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return {
    ...(found["resource_metadata"] ? { resourceMetadata: found["resource_metadata"] } : {}),
    ...(found["scope"] ? { scope: found["scope"] } : {}),
  };
};

/** Where an authorization server's metadata may be, in the order the specification gives. */
export const authorizationServerMetadataUrls = (issuer: URL): string[] => {
  const path = issuer.pathname.replace(/\/+$/, "");
  return path === ""
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server`,
        `${issuer.origin}/.well-known/openid-configuration`,
      ]
    : [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ];
};

const getJson = async (
  http: T3Http,
  url: string,
  what: string,
): Promise<Record<string, unknown> | null> => {
  const answer = await http(url, { headers: { accept: "application/json" } });
  if (answer.status === 404 || answer.status === 405) return null;
  if (answer.status !== 200) {
    throw new T3Error("bad_answer", `${what} answered ${answer.status}`, answer.status);
  }
  return jsonObject(answer, what);
};

/**
 * Find the environment's authorization server and what to ask it for.
 * `origin` has been through `environmentOrigin` already.
 */
export const discover = async (
  http: T3Http,
  origin: string,
  siteHosts: readonly string[],
): Promise<Discovered> => {
  const mcpUrl = `${origin}${MCP_PATH}`;
  // What an unauthenticated call is told: where the resource's metadata is, and the scopes it wants.
  const probe = await http(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
  });
  const challenge =
    probe.status === 401 ? parseChallenge(probe.headers.get("www-authenticate")) : {};

  const candidates = [
    ...(challenge.resourceMetadata ? [challenge.resourceMetadata] : []),
    `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ];
  let resourceMetadata: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    // The challenge's address is the server's choice: the same origin, or it is not used.
    if (publicHttpsUrl(candidate, siteHosts).origin !== origin) continue;
    resourceMetadata = await getJson(http, candidate, "The environment's resource metadata");
    if (resourceMetadata !== null) break;
  }
  if (resourceMetadata === null) {
    throw new T3Error(
      "unsupported",
      "That address does not answer as a T3 Code environment: it has no MCP sign-in",
    );
  }
  const issuerValue = stringsOf(resourceMetadata["authorization_servers"])[0];
  if (issuerValue === undefined) {
    throw new T3Error("bad_answer", "The environment names no authorization server");
  }
  const issuer = publicHttpsUrl(issuerValue, siteHosts);

  let metadata: Record<string, unknown> | null = null;
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    metadata = await getJson(http, candidate, "The authorization server's metadata");
    if (metadata !== null) break;
  }
  if (metadata === null) {
    throw new T3Error("bad_answer", "The environment's authorization server has no metadata");
  }
  if (!stringsOf(metadata["code_challenge_methods_supported"]).includes("S256")) {
    throw new T3Error("unsupported", "The environment's sign-in does not support PKCE with S256");
  }
  const endpoint = (name: string, required: boolean): string | undefined => {
    const value = stringOf(metadata[name]);
    if (value === undefined) {
      if (required) throw new T3Error("bad_answer", `The authorization server has no ${name}`);
      return undefined;
    }
    return publicHttpsUrl(value, siteHosts).href;
  };
  const registrationEndpoint = endpoint("registration_endpoint", false);
  const revocationEndpoint = endpoint("revocation_endpoint", false);
  const scopes = challenge.scope
    ? challenge.scope.split(/\s+/).filter(Boolean)
    : stringsOf(resourceMetadata["scopes_supported"]);
  return {
    endpoints: {
      issuer: stringOf(metadata["issuer"]) ?? issuer.href.replace(/\/$/, ""),
      authorizationEndpoint: endpoint("authorization_endpoint", true)!,
      tokenEndpoint: endpoint("token_endpoint", true)!,
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
    },
    resource: stringOf(resourceMetadata["resource"]) ?? mcpUrl,
    scopes,
  };
};

export interface RegisteredClient {
  readonly clientId: string;
  /** Only when the server made this a confidential client anyway. */
  readonly clientSecret?: string;
}

/** Register the forge with the environment's authorization server (RFC 7591). */
export const registerClient = async (
  http: T3Http,
  endpoints: OAuthEndpoints,
  options: { readonly redirectUri: string },
): Promise<RegisteredClient> => {
  if (endpoints.registrationEndpoint === undefined) {
    throw new T3Error(
      "unsupported",
      "The environment's sign-in does not register clients by itself, which this needs",
    );
  }
  const answer = await http(endpoints.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    // The fields every server takes, and no others: T3 Code's registration
    // reads these and a strict server may refuse what it does not know.
    body: JSON.stringify({
      client_name: "Infrawrench Git",
      redirect_uris: [options.redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  if (answer.status !== 200 && answer.status !== 201) {
    throw new T3Error(
      "bad_answer",
      `The environment refused to register this site (${answer.status})`,
      answer.status,
    );
  }
  const body = jsonObject(answer, "The registration");
  const clientId = stringOf(body["client_id"]);
  if (clientId === undefined) throw new T3Error("bad_answer", "The registration has no client id");
  const clientSecret = stringOf(body["client_secret"]);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
};

// PKCE and state

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 32 random bytes, base64url: a PKCE verifier, or a `state`. */
export const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const pkceChallenge = async (verifier: string): Promise<string> =>
  base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

export const authorizeUrl = (
  endpoints: OAuthEndpoints,
  request: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
    readonly resource: string;
    readonly scopes: readonly string[];
  },
): string => {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", request.resource);
  if (request.scopes.length > 0) url.searchParams.set("scope", request.scopes.join(" "));
  return url.href;
};

export interface TokenSet {
  readonly accessToken: string;
  /** Absent when the server did not rotate it: the one in hand stays. */
  readonly refreshToken?: string;
  readonly expiresAt: Date | null;
  /** Absent when the answer did not say: what was asked for stands. */
  readonly scopes?: readonly string[];
}

const tokenRequest = async (
  http: T3Http,
  endpoints: OAuthEndpoints,
  client: RegisteredClient,
  params: Record<string, string>,
  now: Date,
): Promise<TokenSet> => {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientSecret !== undefined) body.set("client_secret", client.clientSecret);
  const answer = await http(endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (answer.status !== 200) {
    // `invalid_grant`: the code or the refresh token is spent. The person signs in again.
    throw new T3Error(
      answer.status === 400 || answer.status === 401 ? "not_signed_in" : "bad_answer",
      answer.status === 400 || answer.status === 401
        ? "The environment did not accept the sign-in. Sign in to it again."
        : `The environment's sign-in answered ${answer.status}`,
      answer.status,
    );
  }
  const json = jsonObject(answer, "The token answer");
  const accessToken = stringOf(json["access_token"]);
  if (accessToken === undefined) throw new T3Error("bad_answer", "The token answer has no token");
  const type = stringOf(json["token_type"]);
  if (type !== undefined && type.toLowerCase() !== "bearer") {
    throw new T3Error("unsupported", "The environment issued a token this site cannot use");
  }
  const expiresIn = Number(json["expires_in"]);
  const refreshToken = stringOf(json["refresh_token"]);
  const scope = stringOf(json["scope"]);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(now.getTime() + expiresIn * 1000)
        : null,
    ...(scope ? { scopes: scope.split(/\s+/).filter(Boolean) } : {}),
  };
};

export const exchangeCode = (
  http: T3Http,
  endpoints: OAuthEndpoints,
  client: RegisteredClient,
  request: {
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
    readonly resource: string;
  },
  now: Date = new Date(),
): Promise<TokenSet> =>
  tokenRequest(
    http,
    endpoints,
    client,
    {
      grant_type: "authorization_code",
      code: request.code,
      code_verifier: request.verifier,
      redirect_uri: request.redirectUri,
      resource: request.resource,
    },
    now,
  );

export const refreshTokens = (
  http: T3Http,
  endpoints: OAuthEndpoints,
  client: RegisteredClient,
  request: { readonly refreshToken: string; readonly resource: string },
  now: Date = new Date(),
): Promise<TokenSet> =>
  tokenRequest(
    http,
    endpoints,
    client,
    {
      grant_type: "refresh_token",
      refresh_token: request.refreshToken,
      resource: request.resource,
    },
    now,
  );

/** Revoke a token (RFC 7009). Best effort: a server without the endpoint, or away, revokes nothing. */
export const revokeToken = async (
  http: T3Http,
  endpoints: OAuthEndpoints,
  client: RegisteredClient,
  token: string,
  hint: "access_token" | "refresh_token",
): Promise<boolean> => {
  if (endpoints.revocationEndpoint === undefined) return false;
  const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.clientId });
  if (client.clientSecret !== undefined) body.set("client_secret", client.clientSecret);
  try {
    const answer = await http(endpoints.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return answer.status === 200;
  } catch {
    return false;
  }
};
