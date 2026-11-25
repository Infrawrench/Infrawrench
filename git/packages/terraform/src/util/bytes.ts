/** Small byte helpers. WebCrypto and `Uint8Array` only, like the rest of the package. */

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A fresh ArrayBuffer-backed copy: `digest` does not take a view over a SharedArrayBuffer.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return toHex(new Uint8Array(digest));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string no longer than `max` characters, cut with an ellipsis when it was longer. */
export function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
