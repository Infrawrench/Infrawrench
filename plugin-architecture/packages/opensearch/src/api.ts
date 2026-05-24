import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpHostServices } from "@infrawrench/plugin-base";

export type AuthMode = "basic" | "apiKey" | "awsSigv4";

export interface OpenSearchAuth {
  mode: AuthMode;
  username?: string;
  password?: string;
  apiKey?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
  awsSessionToken?: string;
  /** SigV4 service name. "es" for AWS OpenSearch Service, "aoss" for Serverless. */
  awsService?: string;
}

export interface OpenSearchConfig {
  /** Base URL — e.g. https://search.example.com:9200. Trailing slash trimmed. */
  endpoint: string;
  auth: OpenSearchAuth;
  caCertificate?: string;
  skipTlsVerify?: boolean;
}

interface OpenSearchResponse<T = unknown> {
  status: number;
  body: T;
  raw: string;
}

export function parseConfig(credentials: Record<string, string>): OpenSearchConfig {
  const rawEndpoint = (credentials["endpoint"] ?? "").trim();
  if (!rawEndpoint) {
    throw new Error("OpenSearch plugin: missing `endpoint` credential.");
  }
  // Strip user:pass@ embedded in the URL — DigitalOcean's connection.uri
  // carries credentials inline. We pull them into the auth object so the
  // request layer can decide what to do with them (sign vs Basic header).
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new Error(`OpenSearch plugin: endpoint is not a valid URL: ${rawEndpoint}`);
  }
  const inlineUser = url.username ? decodeURIComponent(url.username) : "";
  const inlinePass = url.password ? decodeURIComponent(url.password) : "";
  url.username = "";
  url.password = "";
  const endpoint = url.toString().replace(/\/$/, "");

  const modeRaw = (credentials["authMode"] ?? "").trim().toLowerCase();
  const hasAwsCreds = !!credentials["awsAccessKeyId"] && !!credentials["awsSecretAccessKey"];
  const hasApiKey = !!credentials["apiKey"];
  let mode: AuthMode;
  if (modeRaw === "basic" || modeRaw === "apikey" || modeRaw === "awssigv4") {
    mode = modeRaw === "apikey" ? "apiKey" : modeRaw === "awssigv4" ? "awsSigv4" : "basic";
  } else if (hasAwsCreds) {
    mode = "awsSigv4";
  } else if (hasApiKey) {
    mode = "apiKey";
  } else {
    mode = "basic";
  }

  const username = credentials["username"] || inlineUser || undefined;
  const password = credentials["password"] || inlinePass || undefined;

  return {
    endpoint,
    auth: {
      mode,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(credentials["apiKey"] ? { apiKey: credentials["apiKey"] } : {}),
      ...(credentials["awsAccessKeyId"] ? { awsAccessKeyId: credentials["awsAccessKeyId"] } : {}),
      ...(credentials["awsSecretAccessKey"]
        ? { awsSecretAccessKey: credentials["awsSecretAccessKey"] }
        : {}),
      ...(credentials["awsRegion"] ? { awsRegion: credentials["awsRegion"] } : {}),
      ...(credentials["awsSessionToken"]
        ? { awsSessionToken: credentials["awsSessionToken"] }
        : {}),
      ...(credentials["awsService"] ? { awsService: credentials["awsService"] } : {}),
    },
    ...(credentials["caCertificate"] ? { caCertificate: credentials["caCertificate"] } : {}),
    ...(credentials["skipTlsVerify"]?.toLowerCase() === "true" ? { skipTlsVerify: true } : {}),
  };
}

function basicAuthHeader(user: string, pass: string): string {
  // btoa is available in Node ≥18 and the browser; OpenSearch headers are ASCII-only
  // for the user:pass form so we don't need a wider encoding.
  const token = btoa(`${user}:${pass}`);
  return `Basic ${token}`;
}

async function signSigv4(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string,
  auth: OpenSearchAuth,
): Promise<Record<string, string>> {
  if (!auth.awsAccessKeyId || !auth.awsSecretAccessKey) {
    throw new Error("OpenSearch plugin: awsSigv4 auth needs awsAccessKeyId + awsSecretAccessKey.");
  }
  if (!auth.awsRegion) {
    throw new Error("OpenSearch plugin: awsSigv4 auth needs awsRegion.");
  }
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;
  const signer = new SignatureV4({
    service: auth.awsService || "es",
    region: auth.awsRegion,
    credentials: {
      accessKeyId: auth.awsAccessKeyId,
      secretAccessKey: auth.awsSecretAccessKey,
      ...(auth.awsSessionToken ? { sessionToken: auth.awsSessionToken } : {}),
    },
    sha256: Sha256,
  });
  const req = new HttpRequest({
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname || "/",
    query,
    headers: {
      host: url.host,
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    },
    body,
  });
  const signed = await signer.sign(req);
  return signed.headers as Record<string, string>;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  /** Body — JSON-serialised if an object, sent as-is if a string. */
  body?: unknown;
  /** Override Content-Type. Defaults to application/json for bodies. */
  contentType?: string;
  /** Query string parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Throw on non-2xx (default). When false, returns the raw response object. */
  throwOnError?: boolean;
}

function buildUrl(base: string, path: string, query?: RequestOpts["query"]): URL {
  const u = new URL(path.startsWith("/") ? `${base}${path}` : `${base}/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u;
}

/**
 * Issue a request to the OpenSearch cluster.
 *
 * Routes through `services.http` when available so the host can attach a
 * custom CA cert and honour per-account bastion routing. Falls back to
 * global `fetch` in the renderer path when the host service is absent.
 */
export async function osRequest<T = unknown>(
  config: OpenSearchConfig,
  http: HttpHostServices | undefined,
  path: string,
  opts: RequestOpts = {},
): Promise<OpenSearchResponse<T>> {
  const method = opts.method ?? "GET";
  const url = buildUrl(config.endpoint, path, opts.query);

  let bodyStr = "";
  let bodyBytes: string | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === "string") {
      bodyStr = opts.body;
    } else {
      bodyStr = JSON.stringify(opts.body);
    }
    bodyBytes = bodyStr;
  }

  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (bodyBytes !== undefined) {
    headers["content-type"] = opts.contentType ?? "application/json";
  }

  // Apply auth
  switch (config.auth.mode) {
    case "basic": {
      if (!config.auth.username) {
        throw new Error("OpenSearch plugin: basic auth needs `username`.");
      }
      headers["authorization"] = basicAuthHeader(config.auth.username, config.auth.password ?? "");
      break;
    }
    case "apiKey": {
      if (!config.auth.apiKey) {
        throw new Error("OpenSearch plugin: apiKey auth needs `apiKey`.");
      }
      headers["authorization"] = `ApiKey ${config.auth.apiKey}`;
      break;
    }
    case "awsSigv4": {
      const signed = await signSigv4(method, url, headers, bodyStr, config.auth);
      for (const [k, v] of Object.entries(signed)) headers[k] = v;
      break;
    }
  }

  if (http) {
    const result = await http.request({
      url: url.toString(),
      method,
      headers,
      ...(bodyBytes !== undefined ? { body: bodyBytes } : {}),
      ...(config.caCertificate ? { caCert: config.caCertificate } : {}),
    });
    return finalize<T>(method, url, result.status, result.body, opts);
  }

  // Renderer fallback. caCertificate + skipTlsVerify can't be honoured here —
  // the browser/Node fetch lacks per-request trust controls. Plugins should
  // be run via the host's http service for production traffic.
  const init: RequestInit = { method, headers };
  if (bodyBytes !== undefined) init.body = bodyBytes;
  const resp = await fetch(url.toString(), init);
  const raw = await resp.text();
  return finalize<T>(method, url, resp.status, raw, opts);
}

function finalize<T>(
  method: string,
  url: URL,
  status: number,
  raw: string,
  opts: RequestOpts,
): OpenSearchResponse<T> {
  let parsed: unknown = undefined;
  if (raw && raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  const throwOnError = opts.throwOnError !== false;
  if (throwOnError && (status < 200 || status >= 300)) {
    const snippet = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
    throw new Error(
      `OpenSearch ${method} ${url.pathname} failed: ${status}${snippet ? ` — ${snippet}` : ""}`,
    );
  }
  return { status, body: parsed as T, raw };
}
