import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for the Lambda Cloud API (`https://cloud.lambda.ai/api/v1`,
 * OpenAPI 1.10.0 at `/api/v1/openapi.json`, checked 2026-10). Auth is
 * `Authorization: Bearer <key>`. Every success is wrapped as `{data}`, every
 * failure as `{error: {code, message, suggestion?}}`. Lambda documents a rate
 * limit of one request per second (one launch per 12 seconds).
 *
 * Goes through `services.http` when the host provides it (bastion routing,
 * custom CA); plain `fetch` otherwise.
 */

export const API_BASE = "https://cloud.lambda.ai/api/v1";

export class LambdaApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    const parsed = parseError(body);
    super(
      `Lambda Cloud API error ${status} for ${path}: ${parsed.message}${parsed.suggestion ? ` (${parsed.suggestion})` : ""}`,
    );
    this.name = "LambdaApiError";
    this.status = status;
    this.code = parsed.code;
    this.body = body;
  }
}

export function parseError(body: string): { code: string; message: string; suggestion: string } {
  try {
    const e = (
      JSON.parse(body) as { error?: { code?: string; message?: string; suggestion?: string } }
    ).error;
    if (e && (e.message || e.code)) {
      return {
        code: e.code ?? "",
        message: e.message || e.code || "",
        suggestion: e.suggestion ?? "",
      };
    }
  } catch {
    /* not JSON */
  }
  return { code: "", message: body.slice(0, 500) || "(empty response)", suggestion: "" };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export class LambdaApi {
  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  private async send(
    path: string,
    method: string,
    query: Record<string, string | number | undefined> | undefined,
    body: unknown,
  ): Promise<string> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== "") params.append(k, String(v));
    }
    const qs = params.toString();
    const url = `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    const payload = body === undefined ? undefined : JSON.stringify(body);
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
    if (status < 200 || status >= 300) throw new LambdaApiError(status, path, text);
    return text;
  }

  /** Calls the API and unwraps `{data}`. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const text = await this.send(path, opts.method ?? "GET", opts.query, opts.body);
    if (!text) return undefined as unknown as T;
    return (JSON.parse(text) as { data?: T }).data as T;
  }

  /** Every page of a `page_token`-paginated list (only `/instances` paginates today). */
  async listAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const text = await this.send(path, "GET", { page_size: 100, page_token: token }, undefined);
      const raw = (text ? JSON.parse(text) : {}) as { data?: T[]; page_token?: string | null };
      out.push(...(raw.data ?? []));
      token = raw.page_token || undefined;
      if (!token) break;
    }
    return out;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof LambdaApiError && statuses.includes(err.status);
}
