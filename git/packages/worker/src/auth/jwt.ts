/**
 * Verifying a WorkOS access token: an RS256 JWT, checked against the client's
 * JWKS with WebCrypto.
 *
 * No `aud` and no `iss` check, on purpose, for the reasons KNOWLEDGE.md
 * ("Auth") gives for the app: AuthKit access tokens carry no audience, the
 * issuer is not stable across configurations, and the key set is per client
 * (`/sso/jwks/<clientId>`), so a token minted for any other WorkOS client
 * fails the signature. That is the isolation either pin would stand in for.
 */
import { fromBase64, fromUtf8, utf8 } from "./encoding";

export interface JwtClaims {
  readonly sub?: string;
  readonly sid?: string;
  readonly email?: string;
  readonly org_id?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [claim: string]: unknown;
}

/** One key of a JWKS document, as much of it as RS256 needs. */
export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
}

export type JwtFailure = "malformed" | "unsupported" | "unknown_key" | "signature" | "expired";

export type JwtResult =
  | { readonly ok: true; readonly claims: JwtClaims }
  | { readonly ok: false; readonly reason: JwtFailure };

/** Clock skew allowed on `exp` and `nbf`, in seconds. */
const LEEWAY_SECONDS = 30;
/** A token longer than this is not one of ours; refuse it before decoding anything. */
const MAX_TOKEN_LENGTH = 8192;

const decodeJson = (part: string): Record<string, unknown> | null => {
  const bytes = fromBase64(part);
  const text = bytes ? fromUtf8(bytes) : null;
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The claims of a JWT without checking anything. Only for reading `exp` off a token we sealed ourselves. */
export const unverifiedClaims = (token: string): JwtClaims | null => {
  const parts = token.split(".");
  return parts.length === 3 ? decodeJson(parts[1]!) : null;
};

/**
 * Verify an RS256 JWT against a key set. `keys` is asked for the key with the
 * token's `kid`; it answers null when the set has none.
 */
export const verifyJwt = async (
  token: string,
  keys: (kid: string | undefined) => Promise<Jwk | null>,
  now: number = Math.floor(Date.now() / 1000),
): Promise<JwtResult> => {
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  const claims = decodeJson(payloadPart);
  const signature = fromBase64(signaturePart);
  if (!header || !claims || !signature) return { ok: false, reason: "malformed" };
  // The algorithm is ours to choose, never the token's: anything but RS256 is
  // refused before a key is looked up.
  if (header["alg"] !== "RS256") return { ok: false, reason: "unsupported" };

  const kid = typeof header["kid"] === "string" ? header["kid"] : undefined;
  const jwk = await keys(kid);
  if (!jwk) return { ok: false, reason: "unknown_key" };
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return { ok: false, reason: "unsupported" };

  let verified: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      utf8(`${headerPart}.${payloadPart}`),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "signature" };

  const exp = claims["exp"];
  if (typeof exp !== "number" || exp + LEEWAY_SECONDS <= now)
    return { ok: false, reason: "expired" };
  const nbf = claims["nbf"];
  if (typeof nbf === "number" && nbf - LEEWAY_SECONDS > now)
    return { ok: false, reason: "expired" };
  return { ok: true, claims: claims as JwtClaims };
};

interface CachedKeySet {
  readonly keys: readonly Jwk[];
  readonly fetchedAt: number;
}

/** How long a fetched key set is trusted before it is fetched again. */
const JWKS_TTL_MS = 10 * 60 * 1000;
/** How soon an unknown `kid` may trigger another fetch, so a forged `kid` cannot hammer WorkOS. */
const JWKS_REFETCH_FLOOR_MS = 30 * 1000;

/**
 * Key sets by URL. Per isolate, which is what a cache may be on a Worker: a
 * cold isolate fetches once, and a key WorkOS rotates in is found by the
 * refetch an unknown `kid` causes.
 */
const keySets = new Map<string, CachedKeySet>();

const fetchKeySet = async (url: string, fetcher: typeof fetch): Promise<CachedKeySet | null> => {
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const keys =
      typeof body === "object" && body !== null && Array.isArray((body as { keys?: unknown }).keys)
        ? ((body as { keys: Jwk[] }).keys.filter(
            (key) => typeof key === "object" && key !== null && typeof key.kty === "string",
          ) as Jwk[])
        : null;
    return keys ? { keys, fetchedAt: Date.now() } : null;
  } catch {
    return null;
  }
};

const pick = (set: CachedKeySet, kid: string | undefined): Jwk | null => {
  if (kid !== undefined) return set.keys.find((key) => key.kid === kid) ?? null;
  // A token without a `kid` can only mean the one key of a one-key set.
  return set.keys.length === 1 ? set.keys[0]! : null;
};

/** A `keys` function for {@link verifyJwt} backed by a remote JWKS, cached per isolate. */
export const remoteKeySet =
  (url: string, fetcher: typeof fetch = fetch) =>
  async (kid: string | undefined): Promise<Jwk | null> => {
    const cached = keySets.get(url);
    const age = cached ? Date.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
    if (cached && age < JWKS_TTL_MS) {
      const key = pick(cached, kid);
      if (key || age < JWKS_REFETCH_FLOOR_MS) return key;
    }
    const fresh = await fetchKeySet(url, fetcher);
    if (!fresh) return cached ? pick(cached, kid) : null;
    keySets.set(url, fresh);
    return pick(fresh, kid);
  };

/** Forget every cached key set. For tests. */
export const clearKeySetCache = (): void => keySets.clear();
