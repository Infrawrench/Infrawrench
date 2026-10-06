import type { HostServices } from "@infrawrench/plugin-base";

/**
 * Transport for Runpod's three API surfaces, all authenticated with the same
 * API key (verified 2026-10):
 *
 * - REST (`https://rest.runpod.io/v1`, OpenAPI at `/v1/openapi.json`): pods,
 *   Serverless endpoints, templates, network volumes, container registry
 *   auths and billing history. `Authorization: Bearer <key>`.
 * - GraphQL (`https://api.runpod.io/graphql`): the only home of the account
 *   (balance, spend limit, SSH public keys, savings plans), GPU type pricing
 *   and stock, data centers, and pod runtime telemetry. Same Bearer header.
 * - Serverless (`https://api.runpod.ai/v2/{endpointId}`): queue health and
 *   purge. The docs send the bare key in `authorization`.
 *
 * Requests go through `services.http` when the host provides it (bastion
 * routing, custom CA, no renderer CORS); plain `fetch` otherwise.
 */

export const REST_BASE = "https://rest.runpod.io/v1";
export const GRAPHQL_URL = "https://api.runpod.io/graphql";
export const SERVERLESS_BASE = "https://api.runpod.ai/v2";

export class RunpodApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, label: string, body: string) {
    super(`Runpod API error ${status} for ${label}: ${summarizeBody(body)}`);
    this.name = "RunpodApiError";
    this.status = status;
    this.body = body;
  }
}

/** REST errors are `{error: "..."}`, GraphQL `{errors: [{message}]}`; show the message. */
export function summarizeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      message?: unknown;
      errors?: Array<{ message?: string }>;
    };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    const first = parsed.errors?.[0]?.message;
    if (first) return first;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500) || "(empty response)";
}

export type QueryValue = string | number | boolean | string[] | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.append(k, String(v));
  }
  return params.toString();
}

export class RunpodApi {
  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    private readonly services: HostServices | undefined,
  ) {}

  private async send(
    url: string,
    label: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<string> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const allHeaders: Record<string, string> = { Accept: "application/json", ...headers };
    if (payload !== undefined) allHeaders["Content-Type"] = "application/json";
    const http = this.services?.http;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers: allHeaders,
        ...(payload !== undefined ? { body: payload } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new RunpodApiError(res.status, label, res.body ?? "");
      }
      return res.body ?? "";
    }
    const res = await fetch(url, {
      method,
      headers: allHeaders,
      ...(payload !== undefined ? { body: payload } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new RunpodApiError(res.status, label, text);
    return text;
  }

  /** REST call against `rest.runpod.io/v1`. Returns parsed JSON, or undefined for an empty body. */
  async rest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const qs = buildQuery(opts.query);
    const text = await this.send(
      `${REST_BASE}${path}${qs ? `?${qs}` : ""}`,
      path,
      method,
      { Authorization: `Bearer ${this.apiKey}` },
      opts.body,
    );
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  /**
   * GraphQL call. Runpod answers application errors with HTTP 200 and an
   * `errors` array; those become a `RunpodApiError` with status 400 (or 401/403
   * when the message says so) so callers can classify them like REST errors.
   */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const text = await this.send(
      GRAPHQL_URL,
      "graphql",
      "POST",
      { Authorization: `Bearer ${this.apiKey}` },
      { query, ...(variables ? { variables } : {}) },
    );
    const parsed = (text ? JSON.parse(text) : {}) as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };
    if (parsed.errors?.length) {
      const first = parsed.errors[0];
      const code = first?.extensions?.code ?? "";
      const msg = first?.message ?? "";
      const status =
        code === "UNAUTHENTICATED" || /unauthori[sz]ed|api key/i.test(msg)
          ? 401
          : code === "FORBIDDEN" || /permission|forbidden/i.test(msg)
            ? 403
            : 400;
      throw new RunpodApiError(status, "graphql", text);
    }
    return parsed.data as T;
  }

  /** Serverless endpoint operation (`api.runpod.ai/v2/{id}/{op}`). */
  async serverless<T>(endpointId: string, op: string, method: "GET" | "POST" = "GET"): Promise<T> {
    const path = `/${encodeURIComponent(endpointId)}/${op}`;
    const text = await this.send(
      `${SERVERLESS_BASE}${path}`,
      path,
      method,
      { Authorization: this.apiKey },
      method === "POST" ? {} : undefined,
    );
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof RunpodApiError && statuses.includes(err.status);
}
