/**
 * Codes and tokens: what the token endpoint gives out and what it takes
 * back.
 *
 * **The access token is a personal access token.** A grant is one row of
 * `git_access_tokens` (`iwg_`, hashed, scoped, owned by the person who
 * consented), so there is one kind of credential on this site and one place
 * that decides what it may do (`repoAccess`): the same token is the MCP
 * client's bearer and what its `git push` sends. It shows on the person's
 * token page under the client's name and is revoked there, or by the client
 * (`/oauth/revoke`). The row's id starts `mcp_`, which is all that tells it
 * from a token the person made by hand.
 *
 * Nothing else is stored, and the table needed no new column:
 *
 * - **An authorization code** is sealed (`sealed.ts`) and carries the id the
 *   grant's row will have. Exchanging it inserts that row, so the primary
 *   key is what makes a code single use: a second exchange finds the id
 *   taken, is refused, and ends the grant the first one made (RFC 6749
 *   section 4.1.2: a code seen twice may have been stolen).
 * - **A refresh token** is sealed and names its grant and the hash of the
 *   access token it was issued beside. Refreshing replaces the row's hash,
 *   compared and swapped on the old one, so each refresh token works once
 *   (OAuth 2.1 section 4.3.1 asks that of public clients) and the previous
 *   access token stops working the moment the next exists. An older refresh
 *   token no longer matches the row: it is refused, and unless the row was
 *   refreshed within the last minute (a client racing itself) the grant is
 *   ended, since one of the two holders is not the client.
 * - **A grant lapses** thirty days after its access token expired without a
 *   refresh. The row's `expires_at` is the access token's, so that is a
 *   comparison, not a column.
 */
import type { GitTokenScope } from "@infrawrench/server-core/db/schema";
import { sha256, sha256Hex, timingSafeEqualText, toBase64Url, utf8 } from "../../auth/encoding";
import { hashAccessToken, mintAccessToken, normalizeScopes } from "../../auth/tokens";
import {
  OAUTH_GRANT_ID_PREFIX,
  getAccessTokenById,
  insertGrantedToken,
  isOAuthGrantId,
  revokeAccessTokenById,
  rotateGrantedToken,
} from "../../db/tokens";
import { findAccessTokenByHash } from "../../db/tokens";
import { OAUTH_LIFETIMES, OAuthFailure, failure, grantLapsesAt } from "./protocol";
import { sealAs, unsealAs } from "./sealed";

export const CODE_PREFIX = "iwa_";
export const REFRESH_TOKEN_PREFIX = "iwr_";

/** A grant's row, as much of it as is read here. */
export interface StoredGrant {
  readonly id: string;
  readonly userId: string;
  readonly hashedToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Where grants are kept. `dbGrantStore` is the table; tests pass a map. */
export interface GrantStore {
  insert(grant: {
    readonly id: string;
    readonly userId: string;
    readonly name: string;
    readonly prefix: string;
    readonly hash: string;
    readonly scopes: readonly GitTokenScope[];
    readonly expiresAt: Date;
  }): Promise<boolean>;
  get(id: string): Promise<StoredGrant | null>;
  findByHash(hash: string): Promise<{ readonly id: string } | null>;
  rotate(rotation: {
    readonly id: string;
    readonly fromHash: string;
    readonly toHash: string;
    readonly prefix: string;
    readonly expiresAt: Date;
  }): Promise<boolean>;
  revoke(id: string): Promise<void>;
}

export const dbGrantStore: GrantStore = {
  insert: insertGrantedToken,
  get: getAccessTokenById,
  findByHash: findAccessTokenByHash,
  rotate: rotateGrantedToken,
  revoke: revokeAccessTokenById,
};

export interface GrantDeps {
  readonly store: GrantStore;
  /** `WORKOS_COOKIE_PASSWORD`: what seals codes and refresh tokens. */
  readonly password: string;
  readonly now?: number;
}

/** What an authorization code carries from the consent to the exchange. */
interface CodeClaims {
  /** The id the grant's row will have. */
  readonly id: string;
  /** The person who consented. */
  readonly u: string;
  /** SHA-256 of the client id it was issued to. */
  readonly c: string;
  /** The client's name, for the token list. */
  readonly n: string;
  /** The redirect URI the code was sent to. */
  readonly r: string;
  /** The PKCE challenge (S256). */
  readonly k: string;
  readonly s: readonly string[];
}

const isCodeClaims = (value: unknown): value is CodeClaims => {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Partial<CodeClaims>;
  return (
    typeof claims.id === "string" &&
    isOAuthGrantId(claims.id) &&
    typeof claims.u === "string" &&
    typeof claims.c === "string" &&
    typeof claims.n === "string" &&
    typeof claims.r === "string" &&
    typeof claims.k === "string" &&
    Array.isArray(claims.s)
  );
};

interface RefreshClaims {
  /** The grant's row. */
  readonly id: string;
  /** The hash of the access token this was issued beside. */
  readonly h: string;
  /** SHA-256 of the client id. */
  readonly c: string;
}

const isRefreshClaims = (value: unknown): value is RefreshClaims => {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Partial<RefreshClaims>;
  return (
    typeof claims.id === "string" &&
    isOAuthGrantId(claims.id) &&
    typeof claims.h === "string" &&
    typeof claims.c === "string"
  );
};

/** A PKCE challenge or verifier's alphabet and length (RFC 7636 section 4). */
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

export const isCodeChallenge = (value: string): boolean => PKCE_VALUE.test(value);

/** The S256 challenge of a verifier. */
export const challengeOf = async (verifier: string): Promise<string> =>
  toBase64Url(await sha256(utf8(verifier)));

export interface CodeRequest {
  readonly userId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly GitTokenScope[];
}

/** An authorization code for a consent just given. */
export const issueCode = async (
  request: CodeRequest,
  deps: Pick<GrantDeps, "password" | "now">,
): Promise<string> => {
  const now = deps.now ?? Date.now();
  const claims: CodeClaims = {
    id: `${OAUTH_GRANT_ID_PREFIX}${crypto.randomUUID()}`,
    u: request.userId,
    c: await sha256Hex(request.clientId),
    n: request.clientName,
    r: request.redirectUri,
    k: request.codeChallenge,
    s: request.scopes,
  };
  const sealed = await sealAs(
    "code",
    claims,
    deps.password,
    now + OAUTH_LIFETIMES.codeSeconds * 1000,
  );
  return `${CODE_PREFIX}${sealed}`;
};

/** The token endpoint's success body (RFC 6749 section 5.1). */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

const refreshTokenFor = async (claims: RefreshClaims, password: string): Promise<string> =>
  `${REFRESH_TOKEN_PREFIX}${await sealAs("refresh", claims, password)}`;

const INVALID_CODE = failure("invalid_grant", "That authorization code is not valid");
const INVALID_REFRESH = failure("invalid_grant", "That refresh token is not valid");

/** How a client is named in the person's token list. */
export const grantName = (clientName: string): string => `${clientName} (MCP)`;

export interface CodeExchange {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  /** OAuth 2.1 no longer sends it here; a client that does must send the one it used. */
  readonly redirectUri: string | null;
}

/** `grant_type=authorization_code`: a code and its verifier for a grant. */
export const exchangeCode = async (
  exchange: CodeExchange,
  deps: GrantDeps,
): Promise<TokenResponse | OAuthFailure> => {
  const now = deps.now ?? Date.now();
  if (!exchange.code.startsWith(CODE_PREFIX)) return INVALID_CODE;
  const claims = await unsealAs(
    "code",
    exchange.code.slice(CODE_PREFIX.length),
    deps.password,
    now,
  );
  if (!isCodeClaims(claims)) return INVALID_CODE;
  if (!timingSafeEqualText(claims.c, await sha256Hex(exchange.clientId))) return INVALID_CODE;
  if (exchange.redirectUri !== null && exchange.redirectUri !== claims.r) return INVALID_CODE;
  if (!PKCE_VALUE.test(exchange.codeVerifier)) {
    return failure("invalid_grant", "The code verifier does not match");
  }
  if (!timingSafeEqualText(await challengeOf(exchange.codeVerifier), claims.k)) {
    return failure("invalid_grant", "The code verifier does not match");
  }

  const scopes = normalizeScopes(claims.s);
  const minted = await mintAccessToken();
  const inserted = await deps.store.insert({
    id: claims.id,
    userId: claims.u,
    name: grantName(claims.n),
    prefix: minted.prefix,
    hash: minted.hash,
    scopes,
    expiresAt: new Date(now + OAUTH_LIFETIMES.accessTokenSeconds * 1000),
  });
  if (!inserted) {
    // The code was exchanged before. Whoever holds the first exchange's
    // tokens may not be the client: they stop working.
    await deps.store.revoke(claims.id);
    return INVALID_CODE;
  }
  return {
    access_token: minted.secret,
    token_type: "Bearer",
    expires_in: OAUTH_LIFETIMES.accessTokenSeconds,
    refresh_token: await refreshTokenFor(
      { id: claims.id, h: minted.hash, c: claims.c },
      deps.password,
    ),
    scope: scopes.join(" "),
  };
};

export interface RefreshExchange {
  readonly refreshToken: string;
  readonly clientId: string;
}

/** `grant_type=refresh_token`: the grant's next access token and refresh token. */
export const refreshGrant = async (
  exchange: RefreshExchange,
  deps: GrantDeps,
): Promise<TokenResponse | OAuthFailure> => {
  const now = deps.now ?? Date.now();
  if (!exchange.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return INVALID_REFRESH;
  const claims = await unsealAs(
    "refresh",
    exchange.refreshToken.slice(REFRESH_TOKEN_PREFIX.length),
    deps.password,
    now,
  );
  if (!isRefreshClaims(claims)) return INVALID_REFRESH;
  if (!timingSafeEqualText(claims.c, await sha256Hex(exchange.clientId))) return INVALID_REFRESH;

  const grant = await deps.store.get(claims.id);
  if (!grant || grant.revokedAt !== null || grant.expiresAt === null) return INVALID_REFRESH;
  if (!timingSafeEqualText(grant.hashedToken, claims.h)) {
    // An older refresh token: it was used already. Just after a refresh that
    // is a client racing itself, and the grant stands; later it is reuse.
    const refreshedAt = grant.expiresAt.getTime() - OAUTH_LIFETIMES.accessTokenSeconds * 1000;
    if (now - refreshedAt > OAUTH_LIFETIMES.refreshRaceSeconds * 1000) {
      await deps.store.revoke(grant.id);
    }
    return INVALID_REFRESH;
  }
  if (now >= grantLapsesAt(grant.expiresAt).getTime()) return INVALID_REFRESH;

  const minted = await mintAccessToken();
  const rotated = await deps.store.rotate({
    id: grant.id,
    fromHash: claims.h,
    toHash: minted.hash,
    prefix: minted.prefix,
    expiresAt: new Date(now + OAUTH_LIFETIMES.accessTokenSeconds * 1000),
  });
  // Another refresh won between the read and the write.
  if (!rotated) return INVALID_REFRESH;
  return {
    access_token: minted.secret,
    token_type: "Bearer",
    expires_in: OAUTH_LIFETIMES.accessTokenSeconds,
    refresh_token: await refreshTokenFor(
      { id: grant.id, h: minted.hash, c: claims.c },
      deps.password,
    ),
    scope: normalizeScopes(grant.scopes).join(" "),
  };
};

/**
 * RFC 7009: end the grant a token belongs to. An access token or a refresh
 * token; anything else changes nothing, and the answer is the same either
 * way. Only a grant is ended here: a personal access token a person made is
 * revoked from their settings, not by whoever holds a copy.
 */
export const revokeGrant = async (token: string, deps: GrantDeps): Promise<void> => {
  if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
    const claims = await unsealAs(
      "refresh",
      token.slice(REFRESH_TOKEN_PREFIX.length),
      deps.password,
      deps.now ?? Date.now(),
    );
    if (isRefreshClaims(claims)) await deps.store.revoke(claims.id);
    return;
  }
  const found = await deps.store.findByHash(await hashAccessToken(token));
  if (found && isOAuthGrantId(found.id)) await deps.store.revoke(found.id);
};
