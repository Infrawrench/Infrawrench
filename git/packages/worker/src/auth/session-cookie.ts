/**
 * The forge's session cookie: sealing, opening and the `Set-Cookie` lines.
 *
 * The cookie is this host's own. It is host-only (no `Domain`, and the
 * `__Host-` prefix over HTTPS, which browsers enforce), so `app.` and every
 * other subdomain never see it and cannot set it, and it is sealed with
 * `WORKOS_COOKIE_PASSWORD`, this Worker's secret, not the app's. It holds
 * what WorkOS handed back at sign-in (the access and refresh tokens) and who
 * that is, encrypted and authenticated with AES-256-GCM under a key derived
 * from the password with HKDF-SHA256 and a per-cookie salt.
 *
 * `v1.<salt>.<iv>.<ciphertext+tag>`, each part base64url. The version, salt
 * and iv are bound in as additional data, so no part can be swapped for
 * another cookie's.
 */
import type { webcrypto } from "node:crypto";
import { fromBase64, fromUtf8, randomBytes, toBase64Url, utf8 } from "./encoding";

type CryptoKey = webcrypto.CryptoKey;

/** Over HTTPS. `__Host-` requires `Secure`, `Path=/` and no `Domain`. */
export const SESSION_COOKIE = "__Host-iwg-session";
/** Over plain HTTP (local development), where `__Host-` cookies are refused. */
export const SESSION_COOKIE_INSECURE = "iwg-session";
/** Holds the sign-in's CSRF nonce between `/auth/sign-in` and `/auth/callback`. */
export const STATE_COOKIE = "__Host-iwg-auth-state";
export const STATE_COOKIE_INSECURE = "iwg-auth-state";

/** Matches the app's session cookie lifetime; the WorkOS refresh token decides when it really ends. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
export const STATE_MAX_AGE_SECONDS = 10 * 60;

const VERSION = "v1";
const HKDF_INFO = utf8("infrawrench-git/session-cookie/v1");
const MIN_PASSWORD_LENGTH = 32;

const deriveKey = async (password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`WORKOS_COOKIE_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const material = await crypto.subtle.importKey("raw", utf8(password), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const additionalData = (salt: string, iv: string): Uint8Array<ArrayBuffer> =>
  utf8(`${VERSION}.${salt}.${iv}`);

/** Seal any JSON value under the password. */
export const seal = async (value: unknown, password: string): Promise<string> => {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const saltText = toBase64Url(salt);
  const ivText = toBase64Url(iv);
  const key = await deriveKey(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(saltText, ivText) },
    key,
    utf8(JSON.stringify(value)),
  );
  return `${VERSION}.${saltText}.${ivText}.${toBase64Url(new Uint8Array(ciphertext))}`;
};

/** Open a sealed value. Null for anything this password did not seal, whatever is wrong with it. */
export const unseal = async (sealed: string, password: string): Promise<unknown> => {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, saltText, ivText, body] = parts as [string, string, string, string];
  const salt = fromBase64(saltText);
  const iv = fromBase64(ivText);
  const ciphertext = fromBase64(body);
  if (!salt || !iv || !ciphertext || salt.length !== 16 || iv.length !== 12) return null;
  try {
    const key = await deriveKey(password, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(saltText, ivText) },
      key,
      ciphertext,
    );
    const text = fromUtf8(new Uint8Array(plaintext));
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch (error) {
    // A password that is too short is a deployment fault, not a bad cookie.
    if (error instanceof Error && error.message.startsWith("WORKOS_COOKIE_PASSWORD")) throw error;
    return null;
  }
};

/** What the session cookie holds. */
export interface SessionData {
  readonly userId: string;
  readonly email: string;
  /** WorkOS access token (a short-lived JWT): what each request verifies. */
  readonly accessToken: string;
  /** WorkOS refresh token: exchanged when the access token has expired. Single use. */
  readonly refreshToken: string;
  /** WorkOS session id (`sid`), for sign-out. */
  readonly sessionId: string | null;
}

const isSessionData = (value: unknown): value is SessionData => {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data["userId"] === "string" &&
    data["userId"] !== "" &&
    typeof data["email"] === "string" &&
    typeof data["accessToken"] === "string" &&
    typeof data["refreshToken"] === "string" &&
    (data["sessionId"] === null || typeof data["sessionId"] === "string")
  );
};

export const sealSession = (session: SessionData, password: string): Promise<string> =>
  seal(session, password);

export const unsealSession = async (
  sealed: string,
  password: string,
): Promise<SessionData | null> => {
  const value = await unseal(sealed, password);
  return isSessionData(value) ? value : null;
};

/** The cookies of a request, by name. A name sent twice keeps its first value. */
export const parseCookies = (header: string | null | undefined): Map<string, string> => {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const name = part.slice(0, equals).trim();
    if (name === "" || cookies.has(name)) continue;
    cookies.set(name, part.slice(equals + 1).trim());
  }
  return cookies;
};

/** Whether the request arrived over HTTPS, which decides the cookies' names and `Secure`. */
export const isSecureRequest = (request: { readonly url: string }): boolean =>
  new URL(request.url).protocol === "https:";

export const sessionCookieName = (secure: boolean): string =>
  secure ? SESSION_COOKIE : SESSION_COOKIE_INSECURE;

export const stateCookieName = (secure: boolean): string =>
  secure ? STATE_COOKIE : STATE_COOKIE_INSECURE;

const cookieLine = (name: string, value: string, maxAge: number, secure: boolean): string =>
  // No `Domain`: host-only. `Lax` so a link from the app or an email arrives
  // signed in, while a cross-site POST arrives without the cookie.
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

export const setSessionCookie = (sealed: string, secure: boolean): string =>
  cookieLine(sessionCookieName(secure), sealed, SESSION_MAX_AGE_SECONDS, secure);

export const clearSessionCookie = (secure: boolean): string =>
  cookieLine(sessionCookieName(secure), "", 0, secure);

export const setStateCookie = (nonce: string, secure: boolean): string =>
  cookieLine(stateCookieName(secure), nonce, STATE_MAX_AGE_SECONDS, secure);

export const clearStateCookie = (secure: boolean): string =>
  cookieLine(stateCookieName(secure), "", 0, secure);
