/**
 * SigV4-signed HTTP request via `@smithy/signature-v4` + global `fetch`.
 *
 * Replaces the hand-rolled SigV4 implementation that used to live in
 * `auth.ts`. The signer is the same one bundled inside every
 * `@aws-sdk/client-*` package, so we're not duplicating signing logic —
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

export interface SignRequestArgs {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  service: string;
  credentials: AwsCredentials;
}

/**
 * Tail end of the legacy "sign manually, then fetch raw" pattern still used by
 * a handful of delete/create handlers (e.g. Lambda DELETE, Route53 DELETE,
 * SageMaker DeleteEndpoint). Honors `creds.http` so per-account bastion
 * routing applies. Throws on non-2xx like `fetchSigned`. New code should
 * prefer `fetchSigned` or the typed helpers in `client-transport.ts`.
 */
export async function signedRawFetch(
  creds: { http?: import("@infrawrench/plugin-base").HttpHostServices },
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
  },
  errorContext: string,
): Promise<{ status: number; body: string }> {
  if (creds.http) {
    const result = await creds.http.request({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`${errorContext} failed: ${result.status} — ${result.body.slice(0, 400)}`);
    }
    return { status: result.status, body: result.body };
  }
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${errorContext} failed: ${res.status}${detail ? ` — ${detail.slice(0, 400)}` : ""}`,
    );
  }
  return { status: res.status, body: await res.text() };
}

export async function signRequest(req: SignRequestArgs): Promise<Record<string, string>> {
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
 * Issue a SigV4-signed HTTP request and return the raw {@link Response}.
 * Throws on non-2xx status with the response body included in the message.
 */
export async function fetchSigned(
  req: Omit<SignRequestArgs, "body"> & { body?: string | ArrayBuffer | Uint8Array },
): Promise<Response> {
  const bodyForSig = typeof req.body === "string" ? req.body : "";
  const headers = await signRequest({ ...req, body: bodyForSig });

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
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `AWS ${req.service} ${req.method} ${new URL(req.url).pathname} failed: ${result.status}${
          result.body ? ` — ${result.body.slice(0, 400)}` : ""
        }`,
      );
    }
    // Wrap the buffered response in a real `Response` so downstream
    // `.text()` / `.json()` callers keep working unchanged.
    const responseHeaders = new Headers(result.headers);
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
    throw new Error(
      `AWS ${req.service} ${req.method} ${new URL(req.url).pathname} failed: ${res.status}${detail ? ` — ${detail.slice(0, 400)}` : ""}`,
    );
  }
  return res;
}
