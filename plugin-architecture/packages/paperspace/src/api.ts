import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for the Paperspace API (`https://api.paperspace.com/v1`, OpenAPI
 * at `/v1/openapi.json`, docs at docs.digitalocean.com/reference/paperspace;
 * checked 2026-10). This is the API Paperspace launched on 2024-05-15 after
 * DigitalOcean's acquisition; the legacy Core and Gradient endpoints it
 * replaced no longer answer. Auth is `Authorization: Bearer <api key>`;
 * errors are `{code, message, details?}`. Lists are cursor paginated:
 * `?after=<nextPage>&limit=<=120`, answering `{items, hasMore, nextPage}`.
 */

export const API_BASE = "https://api.paperspace.com/v1";

export class PaperspaceApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    let code = "";
    let message = body.slice(0, 500) || "(empty response)";
    try {
      const p = JSON.parse(body) as { code?: string; message?: string };
      if (p.message) message = p.message;
      code = p.code ?? "";
    } catch {
      /* not JSON */
    }
    super(`Paperspace API error ${status} for ${path}: ${message}`);
    this.name = "PaperspaceApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class PaperspaceApi {
  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") params.append(k, String(v));
    }
    const qs = params.toString();
    const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
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
    if (status < 200 || status >= 300) throw new PaperspaceApiError(status, path, text);
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  /** Every page of a cursor-paginated list. */
  async listAll<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await this.request<{ items?: T[]; hasMore?: boolean; nextPage?: string | null }>(
        path,
        { query: { ...query, limit: 120, ...(after ? { after } : {}) } },
      );
      out.push(...(res?.items ?? []));
      after = res?.hasMore && res.nextPage ? res.nextPage : undefined;
      if (!after) break;
    }
    return out;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof PaperspaceApiError && statuses.includes(err.status);
}
