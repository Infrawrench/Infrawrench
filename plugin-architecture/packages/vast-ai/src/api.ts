import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for the Vast.ai REST API (`https://console.vast.ai/api/v0`, plus
 * `/api/v1` for the paginated instance and invoice lists). Verified 2026-10
 * against the published OpenAPI document
 * (`https://docs.vast.ai/api-reference/openapi.yaml`) and the `vast-cli`
 * source. Auth is `Authorization: Bearer <key>`. Errors are usually
 * `{success: false, error, msg}`, sometimes only `msg`/`message`, and a rate
 * limit is a 429 whose body may be plain text.
 */

export const API_ORIGIN = "https://console.vast.ai";

export class VastApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Vast.ai API error ${status} for ${path}: ${summarize(body)}`);
    this.name = "VastApiError";
    this.status = status;
    this.body = body;
  }
}

export function summarize(body: string): string {
  try {
    const p = JSON.parse(body) as { msg?: unknown; message?: unknown; error?: unknown };
    for (const v of [p.msg, p.message, p.error]) if (typeof v === "string" && v) return v;
  } catch {
    /* plain text */
  }
  return body.slice(0, 500) || "(empty response)";
}

type QueryValue = string | number | boolean | object | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Objects are JSON-encoded, which is how Vast reads `select_filters` and friends. */
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export class VastApi {
  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  /** `path` includes the version prefix, e.g. `/api/v0/users/current/`. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      params.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const qs = params.toString();
    const url = `${API_ORIGIN}${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    let status: number;
    let text: string;
    const http = this.services?.http;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      status = res.status;
      text = res.body ?? "";
    } else {
      const res = await fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
      status = res.status;
      text = await res.text();
    }
    if (status < 200 || status >= 300) throw new VastApiError(status, path, text);
    if (!text) return undefined as unknown as T;
    const parsed = JSON.parse(text) as T & { success?: boolean; msg?: string; error?: string };
    // Some endpoints answer 200 with `success: false`.
    if (parsed && typeof parsed === "object" && parsed.success === false) {
      throw new VastApiError(400, path, text);
    }
    return parsed;
  }

  /** Keyset pagination: `after_token` in, `next_token` out. */
  async paginate<T>(
    path: string,
    key: string,
    query: Record<string, QueryValue> = {},
    maxPages = 200,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request<Record<string, unknown>>(path, {
        query: { ...query, ...(token ? { after_token: token } : {}) },
      });
      out.push(...((res?.[key] as T[] | undefined) ?? []));
      token = (res?.["next_token"] as string | null | undefined) || undefined;
      if (!token) break;
    }
    return out;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof VastApiError && statuses.includes(err.status);
}
