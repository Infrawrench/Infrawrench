import type { HttpHostServices } from "@infrawrench/plugin-base";
import { serviceHost, type OciService } from "./regions.js";
import { importPrivateKey, signRequest, type OciSigningCredentials } from "./signer.js";

/**
 * An OCI API failure. `code` is the service's own error code from the
 * `{code, message}` body (`NotAuthorizedOrNotFound`, `NotAuthenticated`,
 * `TooManyRequests`, …), which callers branch on: OCI answers 404 for both
 * "missing" and "forbidden", so the status alone never says which.
 */
export class OciApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly serviceMessage: string,
    readonly path: string,
  ) {
    super(
      `Oracle Cloud API error ${status}${code ? ` ${code}` : ""} for ${path}: ${serviceMessage}`,
    );
    this.name = "OciApiError";
  }
}

export interface OciRequest {
  service: OciService;
  region: string;
  method?: string;
  /** Path including the API version prefix, e.g. `/20160918/instances`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Return the body as text instead of parsing JSON (kubeconfig content). */
  rawResponse?: boolean;
}

export interface OciResponse<T> {
  data: T;
  headers: Record<string, string>;
}

/** Retry budget for throttling and transient 5xx. */
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * RFC 3986 query encoding. OCI signs the query exactly as sent, so the string
 * built here is the string both signed and requested; `URLSearchParams`
 * would encode a space as `+`, which OCI's verifier reads differently.
 */
export function encodeQuery(query: OciRequest["query"]): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Signed transport for every OCI service. One instance per client; the
 * private key is imported once, lazily, so a malformed key surfaces on the
 * first request (with an actionable message) rather than in the constructor,
 * which the host calls synchronously and for every account at load.
 */
export class OciApi {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly creds: OciSigningCredentials,
    private readonly http: HttpHostServices | undefined,
    private readonly caCert: string,
  ) {}

  get tenancyOcid(): string {
    return this.creds.tenancyOcid;
  }

  get userOcid(): string {
    return this.creds.userOcid;
  }

  private key(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = importPrivateKey(this.creds.privateKeyPem).catch((err: unknown) => {
        // Do not cache a failure: the next call re-reads the same key, but a
        // transient WebCrypto failure should not poison the client.
        this.keyPromise = null;
        throw err;
      });
    }
    return this.keyPromise;
  }

  url(service: OciService, region: string, path: string, query?: OciRequest["query"]): string {
    return `https://${serviceHost(service, region)}${path}${encodeQuery(query)}`;
  }

  async request<T>(req: OciRequest): Promise<OciResponse<T>> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = this.url(req.service, req.region, req.path, req.query);
    const body =
      req.body === undefined
        ? method === "POST" || method === "PUT" || method === "PATCH"
          ? ""
          : undefined
        : JSON.stringify(req.body);
    const key = await this.key();

    for (let attempt = 1; ; attempt++) {
      const headers = await signRequest(key, this.creds, {
        method,
        url,
        ...(body !== undefined ? { body } : {}),
        headers: { accept: "application/json" },
      });
      const res = await this.send(url, method, headers, body);
      if (res.status >= 200 && res.status < 300) {
        const data = (
          req.rawResponse ? res.body : res.body ? JSON.parse(res.body) : undefined
        ) as T;
        return { data, headers: res.headers };
      }
      let code = "";
      let message = res.body;
      try {
        const parsed = JSON.parse(res.body) as { code?: string; message?: string };
        code = parsed.code ?? "";
        message = parsed.message ?? res.body;
      } catch {
        // Non-JSON error body (a gateway page): keep the raw text.
      }
      const retryable = res.status === 429 || res.status === 500 || res.status === 503;
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      throw new OciApiError(res.status, code, message, req.path);
    }
  }

  /**
   * Object Storage PutObject: a raw body, signed without the body headers
   * (Oracle's documented exception for uploads).
   */
  async putObject(
    region: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const url = this.url("objectstorage", region, path);
    const key = await this.key();
    const headers = await signRequest(key, this.creds, {
      method: "PUT",
      url,
      excludeBody: true,
      headers: { "content-type": contentType || "application/octet-stream" },
    });
    let status: number;
    let text = "";
    if (this.http) {
      const res = await this.http.request({
        url,
        method: "PUT",
        headers,
        body: bytes,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      status = res.status;
      text = res.body;
    } else {
      const res = await fetch(url, { method: "PUT", headers, body: bytes as BodyInit });
      status = res.status;
      if (!res.ok) text = await res.text();
    }
    if (status < 200 || status >= 300) {
      let code = "";
      let message = text;
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string };
        code = parsed.code ?? "";
        message = parsed.message ?? text;
      } catch {
        // keep raw
      }
      throw new OciApiError(status, code, message, path);
    }
  }

  async get<T>(
    service: OciService,
    region: string,
    path: string,
    query?: OciRequest["query"],
  ): Promise<T> {
    return (await this.request<T>({ service, region, path, ...(query ? { query } : {}) })).data;
  }

  async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    // Prefer the host's HTTP service: it is the only path that honours a
    // custom CA and bastion egress routing.
    if (this.http) {
      const result = await this.http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(result.headers ?? {})) lower[k.toLowerCase()] = v;
      return { status: result.status, headers: lower, body: result.body };
    }
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const lower: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      lower[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: lower, body: await res.text() };
  }

  /**
   * Follow `opc-next-page` to the end. Items are either the response body
   * itself (most list operations return a bare array) or under `items`
   * (Object Storage, Monitoring, Usage, OKE collections). A page can be empty
   * while more remain, so the header, not the item count, decides when to stop.
   */
  async listAll<T>(req: OciRequest, maxPages = 50): Promise<T[]> {
    const out: T[] = [];
    let page: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const res = await this.request<T[] | { items?: T[] }>({
        ...req,
        query: { ...(req.query ?? {}), ...(page ? { page } : {}) },
      });
      const items = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
      out.push(...items);
      page = res.headers["opc-next-page"];
      if (!page) break;
    }
    return out;
  }
}

/** True for the answers OCI gives when a credential lacks a policy grant. */
export function isAuthorizationGap(err: unknown): boolean {
  return (
    err instanceof OciApiError &&
    (err.status === 403 || (err.status === 404 && err.code === "NotAuthorizedOrNotFound"))
  );
}
