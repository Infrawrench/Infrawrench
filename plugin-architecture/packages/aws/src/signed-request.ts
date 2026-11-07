/**
 * SigV4-signed HTTP request via `@smithy/signature-v4` + global `fetch`.
 *
 * The signer is the same one bundled inside every
 * `@aws-sdk/client-*` package, so we're not duplicating signing logic:
 * we're just exposing it for the few call sites that still build their
 * own URL/path/body rather than going through a typed SDK Command.
 *
 * Most call sites should prefer the helpers in `client-transport.ts`,
 * which route through per-service AWS SDK clients and so get the
 * correct endpoint per service per region for free (no more
 * SERVICE_HOSTS map and no Neptune-routes-through-RDS bug).
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

import type { AwsCredentials } from "./auth.js";
import { awsErrorCode, AwsRequestError, classifyAwsFailure } from "./aws-errors.js";

interface SignRequestArgs {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  service: string;
  credentials: AwsCredentials;
}

async function signRequest(req: SignRequestArgs): Promise<Record<string, string>> {
  const { method, url: rawUrl, headers, body, service, credentials } = req;
  const parsedUrl = new URL(rawUrl);

  const query: Record<string, string> = {};
  for (const [k, v] of parsedUrl.searchParams.entries()) query[k] = v;

  const signer = new SignatureV4({
    service,
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
    sha256: Sha256,
  });

  const httpRequest = new HttpRequest({
    method,
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname || "/",
    query,
    headers: {
      host: parsedUrl.host,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    },
    ...(body !== undefined ? { body } : {}),
  });

  const signed = await signer.sign(httpRequest);
  return signed.headers as Record<string, string>;
}

/**
 * Waits before retrying a throttled request. The SDK clients retry on their own;
 * a hand-signed call has one attempt otherwise, and one throttle would fail a
 * whole resource type's list. A throttled request did not run, so this holds
 * for writes too.
 */
const THROTTLE_RETRY_MS = [250, 1000];

type SignedRequest = Omit<SignRequestArgs, "body"> & {
  body?: string | ArrayBuffer | Uint8Array;
  /**
   * The response is bytes (a gzip object), not text. Only matters on the
   * host-routed path, whose default decoding is UTF-8 and would corrupt it.
   */
  binary?: boolean;
};

function requestFailed(req: SignedRequest, status: number, headers: Headers, detail: string) {
  const code = awsErrorCode(headers, detail);
  const failure = new AwsRequestError(
    `AWS ${req.service} ${req.method} ${new URL(req.url).pathname} failed: ${status}${
      detail ? `: ${detail.slice(0, 400)}` : ""
    }`,
    status,
    code,
  );
  if (classifyAwsFailure(failure) !== "throttled") return failure;
  // The poller backs off on this wording: AWS throttles with a 400 or a 503 as often as a 429.
  return new AwsRequestError(`${failure.message} (AWS rate limit)`, status, code);
}

async function send(req: SignedRequest, headers: Record<string, string>): Promise<Response> {
  // Route through the host's HTTP service when available so per-account
  // bastion routing applies. SigV4 signing happens above on the same headers
  // regardless of transport, so the signature stays valid either way.
  const http = req.credentials.http;
  if (http) {
    const body =
      req.body === undefined || req.method === "GET" || req.method === "HEAD"
        ? undefined
        : typeof req.body === "string"
          ? req.body
          : req.body instanceof Uint8Array
            ? req.body
            : new Uint8Array(req.body);
    const result = await http.request({
      url: req.url,
      method: req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(req.binary ? { responseEncoding: "binary" as const } : {}),
    });
    // Wrap the buffered response in a real `Response` so downstream
    // `.text()` / `.json()` callers keep working unchanged.
    const responseHeaders = new Headers(result.headers);
    if (result.status < 200 || result.status >= 300) {
      const detail =
        result.body || (result.rawBody ? new TextDecoder().decode(result.rawBody) : "");
      throw requestFailed(req, result.status, responseHeaders, detail);
    }
    if (req.binary && result.rawBody) {
      return new Response(result.rawBody as BodyInit, {
        status: result.status,
        headers: responseHeaders,
      });
    }
    return new Response(result.body, { status: result.status, headers: responseHeaders });
  }

  const fetchInit: RequestInit = { method: req.method, headers };
  if (req.body !== undefined && req.method !== "GET" && req.method !== "HEAD") {
    fetchInit.body = req.body as BodyInit;
  }
  const res = await fetch(req.url, fetchInit);
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore body read failures
    }
    throw requestFailed(req, res.status, res.headers, detail);
  }
  return res;
}

/**
 * Issue a SigV4-signed HTTP request and return the raw {@link Response}.
 * Throws an {@link AwsRequestError} on a non-2xx status, with the response body
 * included in the message, once a throttled request has had its retries.
 */
export async function fetchSigned(req: SignedRequest): Promise<Response> {
  const bodyForSig = typeof req.body === "string" ? req.body : "";
  const headers = await signRequest({ ...req, body: bodyForSig });
  for (const wait of THROTTLE_RETRY_MS) {
    try {
      return await send(req, headers);
    } catch (err) {
      if (classifyAwsFailure(err) !== "throttled") throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return send(req, headers);
}
