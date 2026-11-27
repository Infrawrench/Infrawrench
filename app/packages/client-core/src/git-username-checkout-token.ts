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
 * `iwu_<payload>.<signature>`, the format of `git-handoff-token.ts`, under a
 * label that is this module's own, so a job token is never a checkout token
 * nor the other way round. It travels in a URL, so it lives for minutes and
 * opens one thing: a payment page for that hold, which is no use to anyone
 * but its owner.
 */
import {
  signGitHandoffToken,
  verifyGitHandoffToken,
  type GitHandoffTokenKind,
  type GitHandoffTokenRefusal,
} from "./git-handoff-token";

export const GIT_USERNAME_CHECKOUT_TOKEN_PREFIX = "iwu_";

/** Long enough to follow a redirect, and for a slow page to load. */
export const GIT_USERNAME_CHECKOUT_TOKEN_TTL_SECONDS = 10 * 60;

const MAX_FIELD_LENGTH = 100;

const KIND: GitHandoffTokenKind = {
  prefix: GIT_USERNAME_CHECKOUT_TOKEN_PREFIX,
  label: "infrawrench git username checkout token v1\n",
  maxLength: 512,
};

export interface GitUsernameCheckoutClaims {
  /** `git_username_holds.id`. */
  holdId: string;
  /** The person the hold is for (`users.id`). */
  userId: string;
  /** When it stops working, in seconds since the epoch. */
  expiresAt: number;
}

export type GitUsernameCheckoutTokenRefusal = GitHandoffTokenRefusal;

export type GitUsernameCheckoutTokenResult =
  | { ok: true; claims: GitUsernameCheckoutClaims }
  | { ok: false; reason: GitUsernameCheckoutTokenRefusal };

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
  return signGitHandoffToken(secret, KIND, {
    v: 1,
    hold: claims.holdId,
    user: claims.userId,
    exp: Math.floor(now / 1000) + GIT_USERNAME_CHECKOUT_TOKEN_TTL_SECONDS,
  });
}

/**
 * Checks a token: its signature (in constant time, by WebCrypto), then its
 * expiry. The claims of a refused token are never returned.
 */
export function verifyGitUsernameCheckoutToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<GitUsernameCheckoutTokenResult> {
  return verifyGitHandoffToken(
    secret,
    KIND,
    token,
    ({ v, hold, user, exp }) =>
      v === 1 && validField(hold) && validField(user) && typeof exp === "number"
        ? { holdId: hold, userId: user, expiresAt: exp }
        : null,
    now,
  );
}
