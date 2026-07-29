/**
 * Base64 ↔ bytes, working in every environment a plugin client runs in.
 *
 * **Do not reach for `Buffer` in plugin client code.** Clients run in three
 * places: the web server (Node), the poller (Node), and the Electron
 * *renderer*. The renderer is created with `nodeIntegration: false` and
 * `contextIsolation: true`, so it has no Node globals at all — a bare
 * `Buffer.from(...)` there throws `Buffer is not defined` and takes the whole
 * operation with it. Only `./node-driver` exports are guaranteed a Node
 * runtime. (The AWS plugin has carried a `typeof Buffer !== "undefined"` guard
 * for exactly this reason; these helpers are that guard, factored out so every
 * plugin gets it right by default rather than each having to remember.)
 *
 * `atob`/`btoa` are used rather than a `Buffer` fast path because they are
 * global in Node 16+ *and* in every browser context, so one implementation
 * covers all three hosts — and this package deliberately carries no
 * `@types/node`, which is itself the reminder that Node is not a given here.
 */

/**
 * Decode a base64 string (no `data:` prefix) into raw bytes.
 *
 * The returned view owns a plain `ArrayBuffer` — spelled out in the type so the
 * bytes can go straight into a `Blob`/`BodyInit`, which the DOM lib narrows to
 * `ArrayBufferView<ArrayBuffer>` and will not accept an `ArrayBufferLike` for.
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode raw bytes as base64 (no `data:` prefix). */
export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Chunked: spreading a multi-megabyte array into String.fromCharCode blows
  // the argument limit and throws RangeError, which is exactly the size range
  // a speech clip lands in.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Encode a UTF-8 string as base64. */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Decode a base64 string into UTF-8 text. */
export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}
