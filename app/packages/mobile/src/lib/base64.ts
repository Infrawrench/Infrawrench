/**
 * Base64 helpers that don't rely on `btoa`/`Buffer` (neither is guaranteed on
 * Hermes). Terminal payloads travel as base64-of-utf8 inside JSON WS frames.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode a JS string's UTF-8 bytes as base64. */
export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    out += b1 === undefined ? "=" : ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    out += b2 === undefined ? "=" : ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}
