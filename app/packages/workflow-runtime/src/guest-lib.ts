/**
 * Guest-side source shared by every prelude (workflows, Infrafiles, custom
 * graphs). Each block is a fragment of JS spliced into a prelude's IIFE and
 * assumes `rpc` is already defined in the enclosing scope. Factored out so a
 * fix to the hand-rolled codecs or the fetch shim lands in every program kind
 * at once — these are raw strings no typechecker guards against drift.
 */

/** base64/UTF-8 codecs + log-argument formatting (QuickJS guarantees neither atob nor TextDecoder). */
export const GUEST_CODECS = String.raw`
  // Minimal base64 → Uint8Array decode (QuickJS has no guaranteed atob).
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b64 = (s) => {
    if (!s) return new Uint8Array(0);
    const lookup = b64.lookup || (b64.lookup = (() => {
      const t = new Uint8Array(256);
      for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
      return t;
    })());
    let len = s.length;
    while (len > 0 && s[len - 1] === "=") len--;
    const out = new Uint8Array((len * 3) >> 2);
    let bits = 0, acc = 0, p = 0;
    for (let i = 0; i < len; i++) {
      acc = (acc << 6) | lookup[s.charCodeAt(i)];
      bits += 6;
      if (bits >= 8) { bits -= 8; out[p++] = (acc >> bits) & 0xff; }
    }
    return out;
  };
  // Minimal UTF-8 decode (avoid assuming TextDecoder).
  const utf8 = (bytes) => {
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    let out = "";
    for (let i = 0; i < bytes.length;) {
      const c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
      else if (c < 0xf0)
        out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
      else {
        const cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        const u = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
      }
    }
    return out;
  };

  // Format one log argument: strings pass through, byte buffers (Uint8Array,
  // any TypedArray/DataView, or a raw ArrayBuffer) are decoded as UTF-8 text so
  // that e.g. infra.log(await r.sftp.get(path)) prints the file, not {"0":104,…}.
  const fmtPart = (p) => {
    if (typeof p === "string") return p;
    if (p instanceof Uint8Array) return utf8(p);
    if (typeof ArrayBuffer !== "undefined") {
      if (p instanceof ArrayBuffer) return utf8(new Uint8Array(p));
      if (ArrayBuffer.isView(p)) return utf8(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    }
    return JSON.stringify(p);
  };
  const fmtParts = (parts) => parts.map(fmtPart).join(" ");

  // Minimal Uint8Array → base64 encode (QuickJS has no guaranteed btoa).
  const b64enc = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
      out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
      out += i + 2 < bytes.length ? B64[c & 63] : "=";
    }
    return out;
  };
  // Coerce a workflow value (string | Uint8Array) into bytes for upload.
  const toBytes = (data) => {
    if (typeof data !== "string") return data;
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(data);
    const out = [];
    for (let i = 0; i < data.length; i++) {
      let c = data.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff) {
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (data.charCodeAt(++i) & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  };
`;

/** The WHATWG-ish `fetchImpl` (headers view, body coercion, buffered response). */
export const GUEST_FETCH = String.raw`
  // A minimal WHATWG-ish Headers view over the plain object the host returns.
  // Names arrive lowercased; get/has lowercase what they're asked for so
  // res.headers.get("Content-Type") works like it does everywhere else.
  const makeHeaders = (raw) => {
    const map = raw || {};
    return {
      get: (name) => {
        const v = map[String(name).toLowerCase()];
        return v === undefined ? null : v;
      },
      has: (name) => Object.prototype.hasOwnProperty.call(map, String(name).toLowerCase()),
      keys: () => Object.keys(map),
      entries: () => Object.entries(map),
      forEach: (fn) => { for (const [k, v] of Object.entries(map)) fn(v, k); },
      toJSON: () => Object.assign({}, map),
    };
  };

  // Coerce a fetch body into bytes. Strings and byte buffers pass through
  // toBytes; anything else is JSON (with a content-type, unless one was set),
  // so posting an object is one call rather than a stringify + header dance.
  const fetchBody = (body, headers) => {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string" || body instanceof Uint8Array) return toBytes(body);
    if (typeof ArrayBuffer !== "undefined") {
      if (body instanceof ArrayBuffer) return new Uint8Array(body);
      if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    return toBytes(JSON.stringify(body));
  };

  // The sandbox has no sockets: fetch is an RPC the host performs on our
  // behalf. The body is fully buffered (bounded by maxBytes), so the reader
  // methods below are synchronous underneath but still return promises, and
  // await res.json() reads the same as it does anywhere else. Unlike a real
  // Response the body isn't single-use; you can read it twice.
  const fetchImpl = async (url, init) => {
    init = init || {};
    const headers = Object.assign({}, init.headers || {});
    const bytes = fetchBody(init.body, headers);
    const res = await rpc("fetch", {
      request: {
        url: typeof url === "string" ? url : String(url),
        method: init.method,
        headers,
        bodyBase64: bytes === undefined ? undefined : b64enc(bytes),
        timeoutMs: init.timeoutMs,
        maxBytes: init.maxBytes,
        redirect: init.redirect,
      },
    });
    const body = b64(res.bodyBase64 || "");
    return {
      status: res.status,
      statusText: res.statusText || "",
      ok: res.status >= 200 && res.status < 300,
      url: res.url,
      redirected: !!res.redirected,
      headers: makeHeaders(res.headers),
      text: () => Promise.resolve(utf8(body)),
      json: () => Promise.resolve(JSON.parse(utf8(body))),
      bytes: () => Promise.resolve(body),
      arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
    };
  };
`;

/** console.* routed to the run log. */
export const GUEST_CONSOLE = String.raw`
  // Route console.* to the run log as well.
  const c = (level) => (...parts) => rpc("log", { level, message: fmtParts(parts) });
  globalThis.console = { log: c("info"), info: c("info"), warn: c("warn"), error: c("error"), debug: c("debug") };
`;
