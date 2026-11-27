/**
 * The token that sends a browser from git.infrawrench.com to the app to set
 * up a workspace: an Infrawrench organisation on the Pro plan, for a person
 * who belongs to none (`git-forge.ts`, `GIT_WORKSPACE_CHECKOUT_PATH`).
 *
 * The forge holds no Stripe key and writes no organisation, so the app opens
 * the Checkout session and, once it is paid, creates the organisation. The
 * two sites have separate session cookies, and the person may never have
 * signed in to the app, so the forge says who they are and what they asked
 * for: the organisation's name, the id it will have, and the forge page to
 * come back to. Nothing is written until the payment settles, so this token
 * is the whole request.
 *
 * `iww_<payload>.<signature>`, the format of `git-handoff-token.ts`, under a
 * label that is this module's own: a job token or a username checkout token
 * is never one of these, nor the other way round. It travels in a URL, so it
 * lives for minutes and opens one thing: a payment page for a workspace the
 * person it names would own.
 */
import { gitWorkspaceNameProblem } from "./git-forge";
import {
  signGitHandoffToken,
  verifyGitHandoffToken,
  type GitHandoffTokenKind,
  type GitHandoffTokenRefusal,
} from "./git-handoff-token";

export const GIT_WORKSPACE_CHECKOUT_TOKEN_PREFIX = "iww_";

/** Long enough to follow a redirect, and for a slow page to load. */
export const GIT_WORKSPACE_CHECKOUT_TOKEN_TTL_SECONDS = 10 * 60;

/** A return path longer than this would not fit in a Checkout session's metadata, which carries it. */
export const GIT_WORKSPACE_RETURN_PATH_MAX_LENGTH = 400;

const MAX_ID_LENGTH = 100;

const KIND: GitHandoffTokenKind = {
  prefix: GIT_WORKSPACE_CHECKOUT_TOKEN_PREFIX,
  label: "infrawrench git workspace checkout token v1\n",
  // The longest name and return path, in JSON and then base64, with room to spare.
  maxLength: 4096,
};

export interface GitWorkspaceCheckoutClaims {
  /**
   * The id the organisation will have (`organizations.id`), chosen by the
   * forge when it signs. One token is one organisation: the link followed
   * twice opens the same payment, and a payment reported twice creates one.
   */
  organizationId: string;
  /** The person who will own it (`users.id`). */
  userId: string;
  /** The organisation's name, as the person typed it, trimmed. */
  name: string;
  /** The forge page to come back to: a path on that site, with its query. */
  returnPath: string;
  /** When it stops working, in seconds since the epoch. */
  expiresAt: number;
}

export type GitWorkspaceCheckoutTokenRefusal = GitHandoffTokenRefusal;

export type GitWorkspaceCheckoutTokenResult =
  | { ok: true; claims: GitWorkspaceCheckoutClaims }
  | { ok: false; reason: GitWorkspaceCheckoutTokenRefusal };

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && value.length <= MAX_ID_LENGTH;

const validName = (value: unknown): value is string =>
  typeof value === "string" && gitWorkspaceNameProblem(value) === null;

/** Whether `value` is a path on the forge and nothing else: it becomes a redirect. */
export const isGitWorkspaceReturnPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= GIT_WORKSPACE_RETURN_PATH_MAX_LENGTH &&
  /^\/(?![/\\])/.test(value) &&
  !value.includes("\\") &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f-\u009f]/.test(value);

/**
 * Signs a token for a workspace. Throws on a key too short to sign with, and
 * on claims the app would refuse.
 */
export async function signGitWorkspaceCheckoutToken(
  secret: string,
  claims: Omit<GitWorkspaceCheckoutClaims, "expiresAt">,
  now: number = Date.now(),
): Promise<string> {
  if (
    !validId(claims.organizationId) ||
    !validId(claims.userId) ||
    !validName(claims.name) ||
    !isGitWorkspaceReturnPath(claims.returnPath)
  ) {
    throw new Error(
      "A workspace checkout token names an organisation, its owner and a page to return to.",
    );
  }
  return signGitHandoffToken(secret, KIND, {
    v: 1,
    org: claims.organizationId,
    user: claims.userId,
    name: claims.name,
    back: claims.returnPath,
    exp: Math.floor(now / 1000) + GIT_WORKSPACE_CHECKOUT_TOKEN_TTL_SECONDS,
  });
}

/**
 * Checks a token: its signature (in constant time, by WebCrypto), then its
 * expiry. The claims of a refused token are never returned.
 */
export function verifyGitWorkspaceCheckoutToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<GitWorkspaceCheckoutTokenResult> {
  return verifyGitHandoffToken(
    secret,
    KIND,
    token,
    ({ v, org, user, name, back, exp }) =>
      v === 1 &&
      validId(org) &&
      validId(user) &&
      validName(name) &&
      isGitWorkspaceReturnPath(back) &&
      typeof exp === "number"
        ? { organizationId: org, userId: user, name, returnPath: back, expiresAt: exp }
        : null,
    now,
  );
}
