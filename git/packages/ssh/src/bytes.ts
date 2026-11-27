/**
 * Byte helpers shared by every layer. Nothing here knows about SSH.
 */

const encoder = new TextEncoder();
// Fatal, so a name or command that is not UTF-8 is refused instead of being
// silently rewritten with replacement characters and then matched against
// something it never was. A leading byte order mark is kept for the same
// reason: text that is decoded and encoded again must come out byte for byte.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const EMPTY = new Uint8Array(0);

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Throws a `TypeError` when the bytes are not valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Compare without an early exit, so the time taken does not say where two
 * values first differ. The lengths themselves are not secret anywhere this
 * is used (tags and keys have fixed sizes).
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) acc |= bytes[i]!;
  return acc === 0;
}

/**
 * WebCrypto's types want a view over a plain `ArrayBuffer`; streams hand out
 * views typed over `ArrayBufferLike`. Nothing in this package is backed by a
 * `SharedArrayBuffer`, so the narrowing is only for the compiler.
 */
export function source(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Strict: standard alphabet, padding optional, no whitespace. Returns null on anything else. */
export function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", source(data)));
}
