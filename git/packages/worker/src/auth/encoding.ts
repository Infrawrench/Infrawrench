/**
 * The byte and digest helpers the auth modules share. WebCrypto only, so the
 * same code runs in the Worker and in the Node tests.
 */

import type { webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;
type KeyUsage = webcrypto.KeyUsage;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

/** Decode UTF-8, or null when the bytes are not valid UTF-8. */
export const fromUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

export const toHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Decode standard or URL-safe base64, padded or not; null when it is neither. */
export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> | null => {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(standard)) return null;
  const unpadded = standard.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  try {
    const binary = atob(unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const randomBytes = (length: number): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(length));

export const sha256 = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data));

export const sha256Hex = async (text: string): Promise<string> => toHex(await sha256(utf8(text)));

/**
 * Compare two byte strings in time that depends only on their lengths. Used
 * wherever a secret, or a digest of one, is compared with what a caller sent.
 */
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  // The length is not secret (a digest's is fixed), but still fold it into the
  // result rather than returning early, so both inputs are always walked.
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

export const timingSafeEqualText = (a: string, b: string): boolean =>
  timingSafeEqual(utf8(a), utf8(b));

const hmacKey = (secret: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, usages);

export const hmacSha256 = async (
  secret: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), data));

/** Verify an HMAC-SHA256 tag. WebCrypto's own verify compares in constant time. */
export const hmacSha256Verify = async (
  secret: Uint8Array<ArrayBuffer>,
  tag: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> => crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), tag, data);
