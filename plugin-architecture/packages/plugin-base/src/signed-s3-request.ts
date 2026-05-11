/**
 * Shared SigV4 signer for S3-compatible Object Storage endpoints.
 *
 * Multiple plugin clients (AWS, DigitalOcean Spaces, Scaleway Object Storage,
 * …) talk to S3-compatible APIs that require AWS Signature Version 4. Each
 * one was hand-rolling the SigV4 dance against WebCrypto. Three copies of a
 * security primitive is a smell — this helper consolidates the signing onto
 * `@smithy/signature-v4` + `@aws-crypto/sha256-js`, the same primitives the
 * AWS SDK v3 uses.
 *
 * Callers pass an access/secret pair, region, and the request shape; the
 * helper signs and `fetch`es. Returns the raw `Response` so callers can
 * decide how to parse (XML vs JSON vs raw bytes).
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

export interface SignedS3FetchOptions {
  /** S3 access key id. */
  accessKey: string;
  /** S3 secret access key. */
  secretKey: string;
  /** AWS-style region, e.g. `"us-east-1"`, `"nyc3"`, `"fr-par"`. */
  region: string;
  /** Signing service. Defaults to `"s3"`. */
  service?: string;
  /** HTTP method, e.g. `"GET"`, `"PUT"`, `"DELETE"`. */
  method: string;
  /** Fully-qualified URL including scheme, host, path, and any query string. */
  url: string;
  /** Optional extra headers to include in the signed request. */
  headers?: Record<string, string>;
  /**
   * Optional request body. Strings and Uint8Arrays are signed with their
   * exact payload hash; `undefined` is signed as an empty body.
   */
  body?: string | Uint8Array;
}

/**
 * Sign an S3-compatible request with AWS SigV4 and `fetch` it.
 *
 * Returns the raw `Response`; non-2xx responses are not thrown — callers
 * inspect `res.ok` and `res.text()` themselves so they can format
 * vendor-flavoured error messages.
 */
export async function signedS3Fetch(opts: SignedS3FetchOptions): Promise<Response> {
  const { accessKey, secretKey, region, method, url, headers, body } = opts;
  const service = opts.service ?? "s3";

  const parsed = new URL(url);
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const signer = new SignatureV4({
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    region,
    service,
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    path: parsed.pathname || "/",
    query,
    headers: { host: parsed.host, ...(headers ?? {}) },
    body,
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
  });

  const signed = await signer.sign(request);

  const init: RequestInit = {
    method,
    headers: signed.headers,
  };
  if (body !== undefined) {
    // Uint8Array is a valid BodyInit at runtime, but the DOM lib types it as
    // BufferSource only via ArrayBufferView; cast to satisfy structural checks.
    init.body = body as BodyInit;
  }

  return fetch(url, init);
}
