import type { HttpHostServices } from "@infrawrench/plugin-base";
import { API_VERSIONS, endpointFor, ossEndpoint, type AliProduct } from "./regions.js";
import { canonicalQuery, encodePath, signAcs3, signOssV4, type AcsCredentials } from "./signer.js";

/**
 * An Alibaba Cloud API failure. `status` is the HTTP status (the poller
 * classifies on it), `code` the service's own error code (`Forbidden.RAM`,
 * `InvalidAccessKeyId.NotFound`, `Throttling.User`, `NoSuchBucket`, …).
 */
export class AliApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly serviceMessage: string,
    readonly action: string,
    readonly requestId = "",
  ) {
    super(
      `Alibaba Cloud API error ${status}${code ? ` ${code}` : ""} for ${action}: ${serviceMessage}`,
    );
    this.name = "AliApiError";
  }
}

/** True for the answers Alibaba gives when the RAM identity lacks a permission. */
export function isPermissionGap(err: unknown): boolean {
  if (!(err instanceof AliApiError)) return false;
  if (err.status === 403) return true;
  return /^(Forbidden|NoPermission|Unauthorized|NotAuthorized)/i.test(err.code);
}

/** True when the service is simply not opened/available for this account or region. */
export function isServiceUnavailable(err: unknown): boolean {
  if (!(err instanceof AliApiError)) return false;
  return /NotOpen|NotActivated|ServiceNotEnabled|InvalidRegionId|UnsupportedRegion|Region\.NotSupport|InvalidRegion|EntityNotExist\.Role/i.test(
    err.code,
  );
}

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flatten RPC parameters the way Alibaba's SDKs do for `repeatList` and
 * nested object params: `{ Tag: [{ Key: "a" }] }` becomes `Tag.1.Key=a`,
 * `{ SystemDisk: { Size: 40 } }` becomes `SystemDisk.Size=40`. Empty values
 * are dropped so optional fields never reach the wire.
 */
export function flattenParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}.${i + 1}`, v));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}.${k}` : k, v);
      }
      return;
    }
    out[prefix] = String(value);
  };
  walk("", params);
  return out;
}

export interface RoaRequest {
  product: AliProduct;
  region: string;
  action: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface OssRequest {
  method: string;
  region: string;
  bucket?: string;
  key?: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Signed transport for every Alibaba Cloud product. Prefers the host HTTP
 * service: it is the only path with bastion egress and a custom CA, and the
 * only one that works in a browser renderer, where Alibaba's API endpoints
 * send no CORS headers.
 */
export class AliApi {
  constructor(
    private readonly creds: AcsCredentials,
    private readonly http: HttpHostServices | undefined,
    private readonly caCert: string,
  ) {}

  get accessKeyId(): string {
    return this.creds.accessKeyId;
  }

  async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
  ): Promise<RawResponse> {
    if (this.http) {
      const res = await this.http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
      return { status: res.status, headers: lower, body: res.body };
    }
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    });
    const lower: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      lower[k.toLowerCase()] = v;
    });
    return { status: res.status, headers: lower, body: await res.text() };
  }

  private parseJsonError(res: RawResponse, action: string): AliApiError {
    let code = "";
    let message = res.body;
    let requestId = "";
    try {
      const parsed = JSON.parse(res.body) as Record<string, unknown>;
      code = String(parsed["Code"] ?? parsed["code"] ?? "");
      message = String(parsed["Message"] ?? parsed["message"] ?? res.body);
      requestId = String(parsed["RequestId"] ?? parsed["requestId"] ?? "");
    } catch {
      // Gateway page or empty body: keep the raw text.
    }
    return new AliApiError(res.status, code, message, action, requestId);
  }

  private retryable(err: AliApiError): boolean {
    return (
      err.status === 429 ||
      err.status === 502 ||
      err.status === 503 ||
      /^Throttling|ServiceUnavailable|SystemBusy|ServiceBusy/i.test(err.code)
    );
  }

  private async signedJson<T>(
    action: string,
    build: () => Promise<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const req = await build();
      const res = await this.send(req.url, req.method, req.headers, req.body);
      if (res.status >= 200 && res.status < 300) {
        if (!res.body) return undefined as T;
        let data: unknown;
        try {
          data = JSON.parse(res.body);
        } catch {
          return res.body as T;
        }
        // BSS and a few others answer 200 with `Success: false`.
        if (data && typeof data === "object" && (data as { Success?: unknown }).Success === false) {
          const d = data as { Code?: string; Message?: string; RequestId?: string };
          throw new AliApiError(
            400,
            d.Code ?? "",
            d.Message ?? "request failed",
            action,
            d.RequestId,
          );
        }
        return data as T;
      }
      const err = this.parseJsonError(res, action);
      if (this.retryable(err) && attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      throw err;
    }
  }

  /**
   * Call an RPC-style action. Parameters go in the query string (`form`
   * moves them to an `application/x-www-form-urlencoded` body, which Quota
   * Center requires and long payloads prefer).
   */
  async rpc<T>(
    product: AliProduct,
    region: string,
    action: string,
    params: Record<string, unknown> = {},
    opts: { form?: boolean } = {},
  ): Promise<T> {
    const host = endpointFor(product, region);
    const flat = flattenParams(params);
    const query = opts.form ? {} : flat;
    const body = opts.form ? canonicalQuery(flat) : "";
    return this.signedJson<T>(action, async () => {
      const { headers } = await signAcs3(this.creds, {
        method: "POST",
        host,
        path: "/",
        query,
        action,
        version: API_VERSIONS[product],
        body,
        ...(opts.form ? { contentType: "application/x-www-form-urlencoded" } : {}),
      });
      const qs = canonicalQuery(query);
      return {
        url: `https://${host}/${qs ? `?${qs}` : ""}`,
        method: "POST",
        headers: { ...headers, accept: "application/json" },
        ...(opts.form ? { body } : {}),
      };
    });
  }

  /** Call a ROA-style action (ACK, Function Compute): a path, a method and a JSON body. */
  async roa<T>(req: RoaRequest): Promise<T> {
    const host = endpointFor(req.product, req.region);
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== "") query[k] = String(v);
    }
    const body = req.body === undefined ? "" : JSON.stringify(req.body);
    return this.signedJson<T>(req.action, async () => {
      const { headers } = await signAcs3(this.creds, {
        method: req.method,
        host,
        path: req.path,
        query,
        action: req.action,
        version: API_VERSIONS[req.product],
        body,
        ...(req.body !== undefined ? { contentType: "application/json" } : {}),
      });
      const qs = canonicalQuery(query);
      return {
        url: `https://${host}${encodePath(req.path)}${qs ? `?${qs}` : ""}`,
        method: req.method,
        headers: { ...headers, accept: "application/json" },
        ...(req.body !== undefined ? { body } : {}),
      };
    });
  }

  /**
   * An OSS request, signed with V4. Returns the raw response; non-2xx
   * statuses throw with the XML error's `Code` and `Message`.
   */
  async oss(req: OssRequest): Promise<RawResponse> {
    const host = req.bucket ? `${req.bucket}.${ossEndpoint(req.region)}` : ossEndpoint(req.region);
    const parts: string[] = [];
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined) continue;
      parts.push(
        v === "" ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
      );
    }
    const rawQuery = parts.join("&");
    const keyPath = req.key ? `/${req.key.split("/").map(encodeURIComponent).join("/")}` : "/";
    const url = `https://${host}${keyPath}${rawQuery ? `?${rawQuery}` : ""}`;
    const action = `OSS ${req.method} ${req.bucket ?? ""}${req.key ? `/${req.key}` : ""}`;
    for (let attempt = 1; ; attempt++) {
      const headers = await signOssV4(this.creds, {
        method: req.method,
        region: req.region,
        ...(req.bucket ? { bucket: req.bucket } : {}),
        ...(req.key ? { key: req.key } : {}),
        rawQuery,
        headers: req.headers ?? {},
      });
      const res = await this.send(url, req.method, headers, req.body);
      if (res.status >= 200 && res.status < 300) return res;
      const code = /<Code>([^<]*)<\/Code>/.exec(res.body)?.[1] ?? "";
      const message = /<Message>([^<]*)<\/Message>/.exec(res.body)?.[1] ?? res.body;
      const requestId = /<RequestId>([^<]*)<\/RequestId>/.exec(res.body)?.[1] ?? "";
      const err = new AliApiError(res.status, code, message, action, requestId);
      if ((res.status === 503 || res.status === 429) && attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      throw err;
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
