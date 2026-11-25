/**
 * Reading a credential out of an `Authorization` header, for Git over HTTPS
 * and for the API.
 *
 * Git sends Basic. The username means nothing here: `git` insists on one, so
 * people type their own, `x-access-token`, `git` or the token itself, and
 * the secret is whichever field holds something shaped like a credential.
 * The API also takes `Bearer <token>`.
 *
 * Nothing in this module logs or echoes what it parses.
 */
import { fromBase64, fromUtf8 } from "./encoding";

export const ACCESS_TOKEN_PREFIX = "iwg_";
export const API_KEY_PREFIX = "iwk_";
export const JOB_TOKEN_PREFIX = "iwj_";

export type ParsedAuthorization =
  | { readonly scheme: "basic"; readonly username: string; readonly password: string }
  | { readonly scheme: "bearer"; readonly token: string };

/** Parse an `Authorization` header. Null when absent, malformed or another scheme. */
export const parseAuthorization = (
  header: string | null | undefined,
): ParsedAuthorization | null => {
  if (!header) return null;
  const space = header.indexOf(" ");
  if (space <= 0) return null;
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (value === "") return null;
  if (scheme === "bearer") return { scheme: "bearer", token: value };
  if (scheme !== "basic") return null;
  const bytes = fromBase64(value);
  if (!bytes) return null;
  const decoded = fromUtf8(bytes);
  if (decoded === null) return null;
  // RFC 7617: the user-id cannot contain a colon; the password may.
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return {
    scheme: "basic",
    username: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
  };
};

export type CredentialKind = "access-token" | "api-key" | "job-token";

export interface PresentedCredential {
  readonly kind: CredentialKind;
  /** The whole secret, prefix included. */
  readonly secret: string;
}

const classify = (secret: string): PresentedCredential | null => {
  if (secret.startsWith(ACCESS_TOKEN_PREFIX)) return { kind: "access-token", secret };
  if (secret.startsWith(API_KEY_PREFIX)) return { kind: "api-key", secret };
  if (secret.startsWith(JOB_TOKEN_PREFIX)) return { kind: "job-token", secret };
  return null;
};

/**
 * The credential a request presents, or null when it presents none we issue.
 *
 * For Basic, the password is the token; when the password is empty or is not
 * one of ours (`x-oauth-basic`, a habit from other forges), the username is
 * tried, since `https://<token>@host/...` puts it there.
 */
export const presentedCredential = (
  header: string | null | undefined,
): PresentedCredential | null => {
  const parsed = parseAuthorization(header);
  if (!parsed) return null;
  if (parsed.scheme === "bearer") return classify(parsed.token);
  return classify(parsed.password) ?? classify(parsed.username);
};

/**
 * Whether the request tried to authenticate at all. A request that presented
 * something we could not accept gets a 401, never the anonymous answer: `git`
 * would otherwise report "repository not found" for a mistyped token on a
 * private repository and "success" on a public one.
 */
export const presentsCredentials = (header: string | null | undefined): boolean =>
  header !== null && header !== undefined && header.trim() !== "";

/** The challenge a 401 carries so `git` asks for credentials. */
export const BASIC_CHALLENGE = 'Basic realm="git.infrawrench.com", charset="UTF-8"';
