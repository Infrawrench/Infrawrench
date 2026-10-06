/**
 * incident.io API transport.
 *
 * Verified against the public OpenAPI document (`GET
 * https://api.incident.io/v1/openapiV3.json`; the older `/v1/openapi.json`
 * now answers 410) and docs.incident.io, 2026-10:
 *
 * - Base `https://api.incident.io`, `Authorization: Bearer <api key>`. Keys
 *   are created under Settings, API keys, with per-key permissions.
 * - Cursor pagination: `page_size` and `after`, answered with
 *   `pagination_meta.after` (absent on the last page). Incidents allow up to
 *   250 per page.
 * - Filters are deep-object query parameters: `status_category[one_of]=live`,
 *   `updated_at[gte]=2026-10-01`, each repeated for several values.
 * - Errors: `{ type, status, request_id, errors: [{ code, message, source? }] }`.
 * - HTTP alert events go to `POST /v2/alert_events/http/{alert_source_config_id}`
 *   with the source's own `secret_token` as the bearer token, not the API key.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export const API_BASE = "https://api.incident.io";
export const INCIDENT_IO_HOSTNAMES = ["api.incident.io"];
export const PAGE_SIZE = 100;

export interface IncidentIoTransport {
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** An incident.io error with the HTTP status (the poller classifies on it). */
export class IncidentIoApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "IncidentIoApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof IncidentIoApiError ? err.status : undefined;
}

/** A plain value, a list (repeated), or a deep object (`key[op]=v`). */
export type QueryValue =
  string | number | boolean | undefined | string[] | Record<string, string[]>;

export interface IoRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Bearer token override (an alert source's secret token). */
  token?: string;
}

function describeError(status: number, text: string, path: string): IncidentIoApiError {
  let message = text;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      type?: string;
      errors?: Array<{ code?: string; message?: string; source?: { field?: string } }>;
    };
    const errors = parsed.errors ?? [];
    if (errors.length > 0) {
      message = errors
        .map((e) => `${e.message ?? e.code ?? ""}${e.source?.field ? ` (${e.source.field})` : ""}`)
        .join("; ");
      code = errors[0]?.code;
    } else if (parsed.type) {
      message = parsed.type;
    }
  } catch {
    // Not JSON: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the API key (Settings, API keys in incident.io)."
      : status === 403
        ? " The API key is missing a permission this needs; edit the key's permissions in incident.io."
        : status === 429
          ? " incident.io is rate limiting this key; try again shortly."
          : "";
  return new IncidentIoApiError(
    status,
    `incident.io API error ${status} for ${path}: ${message || "(empty)"}.${hint}`,
    code,
  );
}

export function queryString(query: Record<string, QueryValue> | undefined): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) qs.append(k, item);
    else if (typeof v === "object") {
      for (const [op, values] of Object.entries(v)) {
        for (const item of values) qs.append(`${k}[${op}]`, item);
      }
    } else qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export async function ioFetch<T>(
  transport: IncidentIoTransport,
  path: string,
  req: IoRequest = {},
): Promise<T> {
  const method = req.method ?? (req.body !== undefined ? "POST" : "GET");
  const url = `${API_BASE}${path}${queryString(req.query)}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${req.token ?? transport.apiKey}`,
  };
  const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let status: number;
  let text: string;
  if (transport.http) {
    const res = await transport.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(transport.caCert ? { caCert: transport.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) throw describeError(status, text, path);
  if (status === 204 || !text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Walk a cursor-paginated list, reading the array under `key`. */
export async function ioList<T>(
  transport: IncidentIoTransport,
  path: string,
  key: string,
  query: Record<string, QueryValue> = {},
  options: { pageSize?: number; maxItems?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const maxItems = options.maxItems ?? 2000;
  let after: string | undefined;
  for (let page = 0; page < 100 && out.length < maxItems; page++) {
    const res = await ioFetch<Record<string, unknown>>(transport, path, {
      query: { ...query, page_size: pageSize, ...(after ? { after } : {}) },
    });
    const items = Array.isArray(res?.[key]) ? (res[key] as T[]) : [];
    out.push(...items);
    const meta = res?.["pagination_meta"] as { after?: string } | undefined;
    if (!meta?.after || items.length === 0 || meta.after === after) break;
    after = meta.after;
  }
  return out;
}
