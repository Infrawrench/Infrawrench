/**
 * Personal access tokens (`iwg_...`): minting and checking. The storage is
 * `db/tokens.ts`.
 *
 * A token is 32 random bytes, so it is not guessable and its SHA-256 needs no
 * key or salt: the table stores the digest only, and the token is shown once.
 * A presented token is hashed and looked up by that digest; the stored digest
 * is then compared again in constant time, so nothing about how close a guess
 * came leaks through the database's own comparison.
 */
import type { GitTokenScope } from "@infrawrench/server-core/db/schema";
import { ACCESS_TOKEN_PREFIX } from "./credentials";
import { randomBytes, sha256Hex, timingSafeEqualText, toBase64Url } from "./encoding";

export const TOKEN_SCOPES: readonly GitTokenScope[] = ["repo:read", "repo:write"];

/** How much of the token the list shows to tell tokens apart: the prefix and eight characters. */
const DISPLAY_PREFIX_LENGTH = ACCESS_TOKEN_PREFIX.length + 8;

/** The token's length: the prefix and 43 base64url characters (32 bytes). */
export const ACCESS_TOKEN_LENGTH = ACCESS_TOKEN_PREFIX.length + 43;

export interface MintedAccessToken {
  /** The token itself. Returned to the person once and never stored. */
  readonly secret: string;
  /** What the list shows (`iwg_a1b2c3d4`). */
  readonly prefix: string;
  /** Lowercase hex SHA-256 of `secret`: what is stored. */
  readonly hash: string;
}

export const hashAccessToken = (secret: string): Promise<string> => sha256Hex(secret);

export const mintAccessToken = async (): Promise<MintedAccessToken> => {
  const secret = `${ACCESS_TOKEN_PREFIX}${toBase64Url(randomBytes(32))}`;
  return {
    secret,
    prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
    hash: await hashAccessToken(secret),
  };
};

/** Whether a string could be one of our tokens at all, before anything is hashed or queried. */
export const looksLikeAccessToken = (secret: string): boolean =>
  secret.length === ACCESS_TOKEN_LENGTH &&
  secret.startsWith(ACCESS_TOKEN_PREFIX) &&
  /^[A-Za-z0-9_-]+$/.test(secret.slice(ACCESS_TOKEN_PREFIX.length));

/** Keep only the scopes we know, in a stable order, without repeats. */
export const normalizeScopes = (scopes: readonly string[]): GitTokenScope[] =>
  TOKEN_SCOPES.filter((scope) => scopes.includes(scope));

/** A stored token, as `db/tokens.ts` reads it. */
export interface StoredAccessToken {
  readonly id: string;
  readonly userId: string;
  readonly hashedToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface VerifiedAccessToken {
  readonly id: string;
  readonly userId: string;
  readonly scopes: readonly GitTokenScope[];
}

/**
 * Check a presented token against the store. `find` looks a token up by its
 * digest. Null for anything that is not a live token: malformed, unknown,
 * revoked or expired, without saying which.
 */
export const verifyAccessToken = async (
  secret: string,
  find: (hash: string) => Promise<StoredAccessToken | null>,
  now: Date = new Date(),
): Promise<VerifiedAccessToken | null> => {
  if (!looksLikeAccessToken(secret)) return null;
  const hash = await hashAccessToken(secret);
  const stored = await find(hash);
  if (!stored) return null;
  if (!timingSafeEqualText(stored.hashedToken, hash)) return null;
  if (stored.revokedAt !== null) return null;
  if (stored.expiresAt !== null && stored.expiresAt.getTime() <= now.getTime()) return null;
  return { id: stored.id, userId: stored.userId, scopes: normalizeScopes(stored.scopes) };
};
