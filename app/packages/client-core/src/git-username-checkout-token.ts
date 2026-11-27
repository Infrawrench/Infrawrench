/**
 * The token that sends a browser from git.infrawrench.com to the app to pay
 * for a short username (`git-forge.ts`, `GIT_SHORT_USERNAME_MAX_LENGTH`).
 *
 * The forge holds no Stripe key, so the app opens the Checkout session. The
 * two sites have separate session cookies, and the person paying may never
 * have signed in to the app, so the forge says who they are: it mints this
 * token for the hold it just wrote (`git_username_holds`) and redirects the
 * browser to the app with it. The app checks it and reads the hold, the
 * person and the name from the database they share. Nothing but the hold's
 * id and its owner travels in it.
 *
 * `iwu_<payload>.<signature>`: base64url of compact JSON, and base64url of
 * HMAC-SHA256 over a label and the payload's text under `GIT_JOB_TOKEN_KEY`,
 * the one signing key both deployments already have. The label is this
 * module's own, so a job token is never a checkout token nor the other way
 * round. It travels in a URL, so it lives for minutes and opens one thing: a
 * payment page for that hold, which is no use to anyone but its owner.
 */

export const GIT_USERNAME_CHECKOUT_TOKEN_PREFIX = "iwu_";

const LABEL = "infrawrench git username checkout token v1\n";

/** Long enough to follow a redirect, and for a slow page to load. */
export const GIT_USERNAME_CHECKOUT_TOKEN_TTL_SECONDS = 10 * 60;

export interface GitUsernameCheckoutClaims {
  /** `git_username_holds.id`. */
  holdId: string;
  /** The person the hold is for (`users.id`). */
  userId: string;
  /** When it stops working, in seconds since the epoch. */
  expiresAt: number;
}

export type GitUsernameCheckoutTokenRefusal = "malformed" | "signature" | "expired";

export type GitUsernameCheckoutTokenResult =
  | { ok: true; claims: GitUsernameCheckoutClaims }
  | { ok: false; reason: GitUsernameCheckoutTokenRefusal };

const MAX_TOKEN_LENGTH = 512;
const MAX_FIELD_LENGTH = 100;
const MIN_KEY_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(`The git job token key must be at least ${MIN_KEY_LENGTH} characters.`);
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

const validField = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;

/** Signs a token for a hold. Throws on a key too short to sign with. */
export async function signGitUsernameCheckoutToken(
  secret: string,
  claims: { holdId: string; userId: string },
  now: number = Date.now(),
): Promise<string> {
  if (!validField(claims.holdId) || !validField(claims.userId)) {
    throw new Error("A username checkout token names a hold and its owner.");
  }
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        v: 1,
        hold: claims.holdId,
        user: claims.userId,
        exp: Math.floor(now / 1000) + GIT_USERNAME_CHECKOUT_TOKEN_TTL_SECONDS,
      }),
    ),
  );
  const key = await hmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(LABEL + payload));
  return `${GIT_USERNAME_CHECKOUT_TOKEN_PREFIX}${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Checks a token: its signature (in constant time, by WebCrypto), then its
 * expiry. The claims of a refused token are never returned.
 */
export async function verifyGitUsernameCheckoutToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<GitUsernameCheckoutTokenResult> {
  const refused = (reason: GitUsernameCheckoutTokenRefusal): GitUsernameCheckoutTokenResult => ({
    ok: false,
    reason,
  });
  if (
    typeof token !== "string" ||
    token.length > MAX_TOKEN_LENGTH ||
    !token.startsWith(GIT_USERNAME_CHECKOUT_TOKEN_PREFIX)
  ) {
    return refused("malformed");
  }
  const body = token.slice(GIT_USERNAME_CHECKOUT_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot !== body.lastIndexOf(".")) return refused("malformed");
  const payload = body.slice(0, dot);
  const signature = fromBase64Url(body.slice(dot + 1));
  const payloadBytes = fromBase64Url(payload);
  if (!signature || !payloadBytes || signature.length !== 32) return refused("malformed");

  const key = await hmacKey(secret, "verify");
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(LABEL + payload));
  if (!valid) return refused("signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return refused("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refused("malformed");
  }
  const { v, hold, user, exp } = parsed as Record<string, unknown>;
  if (
    v !== 1 ||
    !validField(hold) ||
    !validField(user) ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp)
  ) {
    return refused("malformed");
  }
  if (exp <= Math.floor(now / 1000)) return refused("expired");
  return { ok: true, claims: { holdId: hold, userId: user, expiresAt: exp } };
}
