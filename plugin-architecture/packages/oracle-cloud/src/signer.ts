/**
 * OCI API request signing: the draft-cavage HTTP Signatures profile Oracle
 * documents at
 * https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm
 *
 * Implemented on WebCrypto (`crypto.subtle`, RSASSA-PKCS1-v1_5 + SHA-256)
 * rather than `node:crypto` or the OCI SDK, because plugin clients run in the
 * desktop renderer as well as on the server: WebCrypto is the one RSA signer
 * both have. The SDK would add a few megabytes of transitive dependencies
 * for what is ~150 lines of string assembly and one signature.
 *
 * Two browser constraints shape the header choice:
 *
 * - `Date`, `Host` and `Content-Length` are forbidden request headers in a
 *   browser `fetch`. OCI accepts `x-date` in place of `date`, so that is what
 *   is signed and sent. `host` and `content-length` are still *signed* (OCI
 *   requires them) but never *set*: every transport derives the same values
 *   from the URL and the exact body bytes signed here.
 * - The body hash is over the exact UTF-8 bytes sent, so callers pass the
 *   serialized string and the transport sends that same string.
 */

export interface OciSigningCredentials {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  /** PEM private key: PKCS#8 (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`). */
  privateKeyPem: string;
}

export interface OciUnsignedRequest {
  method: string;
  url: string;
  /** Serialized body, exactly as it will be sent. */
  body?: string;
  /** Extra headers to send (and, for content-type, to sign). */
  headers?: Record<string, string>;
  /**
   * Object Storage PutObject/UploadPart: sign only the date, target and host,
   * never the body headers (Oracle documents this exception).
   */
  excludeBody?: boolean;
  /** `date` is only for reproducing Oracle's published test vectors. */
  dateHeader?: "x-date" | "date";
  /** Override the date header value, for tests. */
  date?: string;
}

/** Thrown when the private key cannot be used; the message is user-facing. */
export class OciKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OciKeyError";
  }
}

const textEncoder = new TextEncoder();

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** DER length octets for `length`. */
function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo, which is the only
 * private-key encoding WebCrypto imports:
 *
 *   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING pkcs1 }
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  // 1.2.840.113549.1.1.1 rsaEncryption, followed by NULL parameters.
  const algorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  const octetString = concat(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const body = concat(version, algorithm, octetString);
  return concat(Uint8Array.of(0x30), derLength(body.length), body);
}

/**
 * Decode a PEM private key into PKCS#8 DER. Rejects the encodings WebCrypto
 * cannot use with a message that says what to do instead.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  // Keys pasted through some UIs lose their newlines or gain literal "\n".
  const text = pem.replace(/\\n/g, "\n").trim();
  if (/ENCRYPTED/.test(text) || /Proc-Type:\s*4,ENCRYPTED/.test(text)) {
    throw new OciKeyError(
      "The private key is protected by a passphrase. Export an unencrypted copy with `openssl rsa -in key.pem -out key-unencrypted.pem` (or generate the API key in the OCI Console, which downloads an unencrypted key) and paste that instead.",
    );
  }
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) {
    throw new OciKeyError(
      "The private key is not a PEM block. Paste the whole file, including the -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- lines.",
    );
  }
  const label = match[1]!;
  let der: Uint8Array;
  try {
    der = bytesFromBase64(match[2]!.replace(/[^A-Za-z0-9+/=]/g, ""));
  } catch {
    throw new OciKeyError("The private key's PEM body is not valid base64.");
  }
  if (label === "PRIVATE KEY") return der;
  if (label === "RSA PRIVATE KEY") return pkcs1ToPkcs8(der);
  throw new OciKeyError(
    `Unsupported key type "${label}". OCI API keys are RSA: paste the private key (BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY), not the public key.`,
  );
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToPkcs8(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new OciKeyError(
      "The private key could not be read as an RSA key. Check that the whole PEM file was pasted unmodified.",
    );
  }
}

async function sha256Base64(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(body));
  return base64FromBytes(new Uint8Array(digest));
}

/** Methods whose body headers OCI requires in the signature. */
function signsBody(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

/**
 * Everything about a signature except the RSA operation: the headers to send
 * and the exact string that gets signed. Split out so tests can compare the
 * signing string with Oracle's documented examples without a private key.
 */
export async function signingPlan(req: OciUnsignedRequest): Promise<{
  headers: Record<string, string>;
  signedHeaderNames: string[];
  signingString: string;
}> {
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  const date = req.date ?? new Date().toUTCString();
  const dateHeader = req.dateHeader ?? "x-date";
  const headers: Record<string, string> = { ...(req.headers ?? {}), [dateHeader]: date };
  const signed: Array<[string, string]> = [
    [dateHeader, date],
    ["(request-target)", `${method.toLowerCase()} ${url.pathname}${url.search}`],
    ["host", url.host],
  ];
  if (signsBody(method) && !req.excludeBody) {
    const body = req.body ?? "";
    const contentType =
      Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ??
      "application/json";
    const sha = await sha256Base64(body);
    headers["content-type"] = contentType;
    headers["x-content-sha256"] = sha;
    signed.push(
      ["content-length", String(textEncoder.encode(body).length)],
      ["content-type", contentType],
      ["x-content-sha256", sha],
    );
  }
  // Drop any case-variant duplicate of content-type the caller passed.
  for (const k of Object.keys(headers)) {
    if (k !== "content-type" && k.toLowerCase() === "content-type") delete headers[k];
  }
  return {
    headers,
    signedHeaderNames: signed.map(([k]) => k),
    signingString: signed.map(([k, v]) => `${k}: ${v}`).join("\n"),
  };
}

/**
 * Build the signed header set for one request. Returns the headers to send:
 * `x-date`, `authorization`, and for body-carrying methods `content-type` and
 * `x-content-sha256`. `host` and `content-length` are signed but not
 * returned, because no transport lets a caller set them reliably.
 */
export async function signRequest(
  key: CryptoKey,
  creds: Pick<OciSigningCredentials, "tenancyOcid" | "userOcid" | "fingerprint">,
  req: OciUnsignedRequest,
): Promise<Record<string, string>> {
  const { headers, signedHeaderNames, signingString } = await signingPlan(req);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    textEncoder.encode(signingString),
  );
  const keyId = `${creds.tenancyOcid}/${creds.userOcid}/${creds.fingerprint}`;
  headers["authorization"] =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
    `headers="${signedHeaderNames.join(" ")}",` +
    `signature="${base64FromBytes(new Uint8Array(signature))}"`;
  return headers;
}
