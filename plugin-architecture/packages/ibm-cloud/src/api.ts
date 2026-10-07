import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * IBM Cloud transport. One API key is exchanged at IAM
 * (`POST https://iam.cloud.ibm.com/identity/token`,
 * `grant_type=urn:ibm:params:oauth:grant-type:apikey`) for a bearer token
 * that every service accepts; the token lasts an hour and is refreshed a
 * few minutes early, or once on a 401. Requests go through the host HTTP
 * service when there is one (bastion egress, custom CA, and IAM sends no
 * CORS headers).
 */

export const IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";

/** An IBM Cloud API failure with the HTTP status and the service's own error code. */
export class IbmApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly serviceMessage: string,
    readonly path: string,
  ) {
    super(`IBM Cloud API error ${status}${code ? ` ${code}` : ""} for ${path}: ${serviceMessage}`);
    this.name = "IbmApiError";
  }
}

export function isPermissionGap(err: unknown): boolean {
  return err instanceof IbmApiError && (err.status === 403 || err.status === 401);
}

/**
 * Pull `code` and `message` out of the several error shapes IBM services
 * use: VPC and Code Engine `{errors:[{code,message}]}`, Resource Controller
 * `{error_code,message}`, Kubernetes Service `{code,description}`, IAM
 * `{errorCode,errorMessage}`.
 */
export function parseIbmError(body: string): { code: string; message: string } {
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    const errors = p["errors"];
    if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
      const e = errors[0] as Record<string, unknown>;
      return { code: String(e["code"] ?? ""), message: String(e["message"] ?? body) };
    }
    return {
      code: String(p["error_code"] ?? p["errorCode"] ?? p["code"] ?? ""),
      message: String(p["message"] ?? p["errorMessage"] ?? p["description"] ?? p["error"] ?? body),
    };
  } catch {
    return { code: "", message: body.slice(0, 500) };
  }
}

interface Token {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  iamId: string;
  subject: string;
}

/** Decode a JWT payload (no verification: IAM just issued it to us). */
export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  const b64 = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface IbmRequest {
  url: string;
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the body as merge-patch (VPC and Code Engine PATCH). */
  mergePatch?: boolean;
  /** Raw string body (XML for COS); `body` is ignored. */
  rawBody?: string | Uint8Array;
  /** Return the body text instead of parsing JSON. */
  text?: boolean;
}

export interface IbmResponse<T> {
  data: T;
  headers: Record<string, string>;
}

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withQuery(url: string, query: IbmRequest["query"]): string {
  if (!query) return url;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  if (!parts.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

export class IbmApi {
  private token: Token | null = null;
  private pending: Promise<Token> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly http: HttpHostServices | undefined,
    private readonly caCert: string,
  ) {}

  async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
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
    res.headers.forEach((v, k) => (lower[k.toLowerCase()] = v));
    return { status: res.status, headers: lower, body: await res.text() };
  }

  private async exchange(): Promise<Token> {
    const body = `grant_type=${encodeURIComponent("urn:ibm:params:oauth:grant-type:apikey")}&apikey=${encodeURIComponent(this.apiKey)}`;
    const res = await this.send(
      IAM_TOKEN_URL,
      "POST",
      { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    );
    if (res.status < 200 || res.status >= 300) {
      const e = parseIbmError(res.body);
      throw new IbmApiError(res.status, e.code, e.message, "/identity/token");
    }
    const data = JSON.parse(res.body) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      expiration?: number;
    };
    const claims = decodeJwt(data.access_token);
    const account = claims["account"] as { bss?: string } | undefined;
    const expiresAt = data.expiration
      ? data.expiration * 1000
      : Date.now() + (data.expires_in ?? 3600) * 1000;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? "",
      expiresAt,
      accountId: account?.bss ?? "",
      iamId: String(claims["iam_id"] ?? ""),
      subject: String(claims["sub"] ?? claims["name"] ?? ""),
    };
  }

  async getToken(force = false): Promise<Token> {
    if (!force && this.token && this.token.expiresAt - Date.now() > 5 * 60_000) return this.token;
    if (!this.pending) {
      this.pending = this.exchange()
        .then((t) => {
          this.token = t;
          return t;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  async accountId(): Promise<string> {
    return (await this.getToken()).accountId;
  }

  async request<T>(req: IbmRequest): Promise<IbmResponse<T>> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = withQuery(req.url, req.query);
    const body =
      req.rawBody !== undefined
        ? req.rawBody
        : req.body === undefined
          ? undefined
          : JSON.stringify(req.body);
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.getToken();
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${token.accessToken}`,
        ...(req.body !== undefined && req.rawBody === undefined
          ? { "content-type": req.mergePatch ? "application/merge-patch+json" : "application/json" }
          : {}),
        ...(req.headers ?? {}),
      };
      const res = await this.send(url, method, headers, body);
      if (res.status >= 200 && res.status < 300) {
        if (req.text) return { data: res.body as T, headers: res.headers };
        const data = (res.body ? JSON.parse(res.body) : undefined) as T;
        return { data, headers: res.headers };
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      if (
        (res.status === 429 || res.status === 502 || res.status === 503) &&
        attempt < MAX_ATTEMPTS
      ) {
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const e = res.headers["content-type"]?.includes("xml")
        ? {
            code: /<Code>([^<]*)<\/Code>/.exec(res.body)?.[1] ?? "",
            message: /<Message>([^<]*)<\/Message>/.exec(res.body)?.[1] ?? res.body,
          }
        : parseIbmError(res.body);
      throw new IbmApiError(res.status, e.code, e.message, new URL(req.url).pathname);
    }
  }

  async get<T>(
    url: string,
    query?: IbmRequest["query"],
    headers?: Record<string, string>,
  ): Promise<T> {
    return (
      await this.request<T>({
        url,
        ...(query ? { query } : {}),
        ...(headers ? { headers } : {}),
      })
    ).data;
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
