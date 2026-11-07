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
import {
  createApiClient,
  withCursorPagination,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";

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

type ErrorResponse = components["schemas"]["ErrorResponse"];

function describeError(status: number, text: string, path: string): IncidentIoApiError {
  let message = text;
  let code: string | undefined;
  try {
    const parsed: Partial<Pick<ErrorResponse, "type" | "errors">> = JSON.parse(text);
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

/**
 * Lists repeat their key and deep objects go as `key[op]=v`, form-encoded. A
 * top-level empty string is not sent: a filter with no value is no filter.
 */
export function queryString(query: Record<string, ParamValue> | undefined): string {
  const qs = new URLSearchParams();
  const add = (key: string, value: ParamValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) for (const item of value) add(key, item);
    else if (typeof value === "object") {
      for (const [op, item] of Object.entries(value)) add(`${key}[${op}]`, item);
    } else qs.append(key, String(value));
  };
  for (const [key, value] of Object.entries(query ?? {})) if (value !== "") add(key, value);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export function createIoApi(transport: IncidentIoTransport) {
  const api = createApiClient<paths>({
    vendor: "incident.io",
    baseUrl: API_BASE,
    headers: { Accept: "application/json", Authorization: `Bearer ${transport.apiKey}` },
    http: transport.http,
    caCert: transport.caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    serializeQuery: (query) => queryString(query).slice(1),
    httpError: ({ status, body, path }) => describeError(status, body, path),
  });
  return withCursorPagination(api, {
    cursorParam: "after",
    sizeParam: "page_size",
    pageSize: PAGE_SIZE,
    maxPages: 100,
    next: "pagination_meta.after",
    stopOnRepeatedCursor: true,
    emptyBodyEndsList: true,
  });
}

export type IoApi = ReturnType<typeof createIoApi>;

/** End a list once it holds this many items. The page that reaches it is kept whole. */
export function upTo(maxItems = 2000): (batch: { length: number }) => boolean {
  let seen = 0;
  return (batch) => (seen += batch.length) >= maxItems;
}
