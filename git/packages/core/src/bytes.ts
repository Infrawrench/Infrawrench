const encoder = new TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF in the text; the default strips it, and then
// re-encoding a file name or message that starts with one would change its bytes.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

/** UTF-8 with replacement characters for bytes that are not UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** UTF-8, or null when the bytes are not valid UTF-8. */
export function decodeTextStrict(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

/** One character per byte. Lossless for any input, unlike UTF-8. */
export function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  // Chunked: String.fromCharCode over a spread of a large array overflows the stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/** The inverse of `decodeLatin1`. Characters above U+00FF lose their high bits. */
export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Unsigned byte order, the order git sorts everything in. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
