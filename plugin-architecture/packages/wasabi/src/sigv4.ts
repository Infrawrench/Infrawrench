/**
 * AWS Signature Version 4, hand-rolled on WebCrypto.
 *
 * S3 wants the path escaped exactly once, and this signer does that; it also
 * signs the IAM and STS query APIs. It predates the fix that made plugin-base's
 * `signedS3Fetch` encode the path once too, and it is the independent oracle
 * that fix's tests take their expected signatures from.
 */

const enc = new TextEncoder();

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const k = await globalThis.crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** RFC 3986 unreserved characters stay; everything else is %XX (uppercase). */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  sessionToken?: string;
  /** Defaults to now. */
  date?: Date;
}

/**
 * Returns the headers to send: the caller's plus `host`, `x-amz-date`,
 * `x-amz-content-sha256`, the session token, and `authorization`.
 */
export async function signV4(input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const date = input.date ?? new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(input.body ?? "");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = String(v).trim();
  headers["host"] = url.host;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = payloadHash;
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;

  // The path is already percent-encoded once by the caller; normalise it to
  // the canonical encoding without encoding it again.
  const canonicalPath =
    url.pathname
      .split("/")
      .map((seg) => uriEncode(decodeURIComponent(seg)))
      .join("/") || "/";
  const params: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => params.push([uriEncode(k), uriEncode(v)]));
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join("&");
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  let key = await hmac(enc.encode(`AWS4${input.secretKey}`), day);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
