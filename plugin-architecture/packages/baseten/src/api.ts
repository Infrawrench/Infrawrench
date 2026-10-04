import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for the Baseten management API (`https://api.baseten.co/v1`).
 * Auth is `Authorization: Bearer <api key>`; Baseten still accepts the older
 * `Api-Key <key>` scheme but documents Bearer as current. Requests go through
 * `services.http` when the host provides it, which keeps bastion routing and
 * custom CAs working.
 *
 * Baseten rate-limits per key (100 req/s by default, 20 req/min on
 * activate/deactivate) and answers a 429 with `{error, retry_after}`. One
 * retry is made when `retry_after` is short; anything longer surfaces as an
 * error rather than stalling a sync.
 */

export const API_HOST = "https://api.baseten.co";

export class BasetenApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Baseten API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "BasetenApiError";
    this.status = status;
    this.body = body;
  }
}

/** Baseten errors are `{error}` (rate limits) or FastAPI-style `{detail}`. */
export function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown; message?: unknown };
    for (const candidate of [parsed.error, parsed.message, parsed.detail]) {
      if (typeof candidate === "string" && candidate) return candidate;
    }
    if (Array.isArray(parsed.detail)) {
      const msgs = parsed.detail
        .map((d) => (d && typeof d === "object" ? (d as { msg?: unknown }).msg : undefined))
        .filter((m): m is string => typeof m === "string");
      if (msgs.length) return msgs.join("; ");
    }
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

export type QueryValue = string | number | boolean | undefined | null | string[];

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/** Repeated keys for arrays (`metrics=a&metrics=b`), which is how Baseten reads list params. */
export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

const MAX_RETRY_AFTER_S = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterSeconds(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    const n = Number(parsed.retry_after);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export class BasetenApi {
  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  private async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; body: string }> {
    const http = this.services?.http;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      return { status: res.status, body: res.body ?? "" };
    }
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: res.status, body: await res.text() };
  }

  /** Raw request: returns the response body as text. Throws on non-2xx. */
  async requestText(path: string, opts: RequestOptions = {}): Promise<string> {
    const method = opts.method ?? "GET";
    const query = buildQuery(opts.query);
    const url = `${API_HOST}${path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res = await this.send(url, method, headers, body);
    if (res.status === 429) {
      const wait = retryAfterSeconds(res.body);
      if (wait !== null && wait <= MAX_RETRY_AFTER_S) {
        await sleep(wait * 1000);
        res = await this.send(url, method, headers, body);
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw new BasetenApiError(res.status, path, res.body);
    }
    return res.body;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.requestText(path, opts);
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof BasetenApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
