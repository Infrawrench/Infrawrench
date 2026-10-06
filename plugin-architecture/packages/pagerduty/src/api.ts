/**
 * PagerDuty transports: the REST API v2 and the Events API v2.
 *
 * Verified against the REST API OpenAPI document
 * (github.com/PagerDuty/api-schema, reference/REST/openapiv3.json) and
 * developer docs (docs.pagerduty.com/developer, 2026-10):
 *
 * - REST: `https://api.pagerduty.com` (EU service region:
 *   `https://api.eu.pagerduty.com`). `Authorization: Token token=<key>`,
 *   `Accept: application/vnd.pagerduty+json;version=2`. Writes that act as a
 *   person (incident status, notes, snooze, creating incidents and maintenance
 *   windows) need a `From: <email of a PagerDuty user>` header with an
 *   account-level key. Errors are `{ error: { message, code, errors[] } }`.
 * - Lists are classic offset pagination: `limit` (max 100), `offset`, and a
 *   `more` flag beside the array.
 * - Events: `POST https://events.pagerduty.com/v2/enqueue` (EU:
 *   `events.eu.pagerduty.com`), no auth header; the routing key in the body
 *   is the credential. 202 `{status, message, dedup_key}`; 400 for a bad body,
 *   429 when throttled.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export type PagerDutyRegion = "us" | "eu";

export function restBase(region: PagerDutyRegion): string {
  return region === "eu" ? "https://api.eu.pagerduty.com" : "https://api.pagerduty.com";
}

export function eventsUrl(region: PagerDutyRegion): string {
  return region === "eu"
    ? "https://events.eu.pagerduty.com/v2/enqueue"
    : "https://events.pagerduty.com/v2/enqueue";
}

export function webBase(subdomain: string | undefined): string {
  return subdomain ? `https://${subdomain}.pagerduty.com` : "https://app.pagerduty.com";
}

export const PAGERDUTY_HOSTNAMES = [
  "api.pagerduty.com",
  "api.eu.pagerduty.com",
  "events.pagerduty.com",
  "events.eu.pagerduty.com",
];

/** Largest page the REST lists accept. */
export const PAGE_LIMIT = 100;

export interface PagerDutyTransport {
  apiKey: string;
  region: PagerDutyRegion;
  caCert?: string;
  http?: HttpHostServices;
}

/** A PagerDuty error, carrying the HTTP status (the poller classifies on it) and PD's code. */
export class PagerDutyApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = "PagerDutyApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof PagerDutyApiError ? err.status : undefined;
}

export type QueryValue = string | number | boolean | undefined | string[];

export interface PdRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** The acting user's email, for the writes that need one. */
  from?: string;
}

function describeError(status: number, text: string, path: string): PagerDutyApiError {
  let message = text;
  let code: number | undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: number; errors?: string[] };
      message?: string;
      errors?: string[];
    };
    const e = parsed.error;
    if (e) {
      message = [e.message, ...(e.errors ?? [])].filter(Boolean).join(": ");
      if (typeof e.code === "number") code = e.code;
    } else if (parsed.message) {
      message = [parsed.message, ...(parsed.errors ?? [])].filter(Boolean).join(": ");
    }
  } catch {
    // Not JSON: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the API key (Integrations, API Access Keys in PagerDuty)."
      : status === 403
        ? " The key cannot do this: a read-only key cannot change anything, and some objects need an admin's key."
        : status === 429
          ? " PagerDuty is rate limiting this key; try again shortly."
          : "";
  return new PagerDutyApiError(
    status,
    `PagerDuty API error ${status} for ${path}: ${message || "(empty)"}.${hint}`,
    code,
  );
}

function queryString(query: Record<string, QueryValue> | undefined): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) qs.append(k, item);
    else qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function send(
  transport: PagerDutyTransport,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<{ status: number; text: string }> {
  if (transport.http) {
    const res = await transport.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(transport.caCert ? { caCert: transport.caCert } : {}),
    });
    return { status: res.status, text: res.body };
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  return { status: res.status, text: await res.text() };
}

/** One REST request. */
export async function pdFetch<T>(
  transport: PagerDutyTransport,
  path: string,
  req: PdRequest = {},
): Promise<T> {
  const method = req.method ?? (req.body !== undefined ? "POST" : "GET");
  const url = `${restBase(transport.region)}${path}${queryString(req.query)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.pagerduty+json;version=2",
    Authorization: `Token token=${transport.apiKey}`,
  };
  if (req.from) headers["From"] = req.from;
  const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const { status, text } = await send(transport, url, method, headers, body);
  if (status < 200 || status >= 300) throw describeError(status, text, path);
  if (status === 204 || !text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Walk an offset-paginated list, reading the array under `key`. */
export async function pdList<T>(
  transport: PagerDutyTransport,
  path: string,
  key: string,
  query: Record<string, QueryValue> = {},
  maxItems = 2000,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < maxItems; offset += PAGE_LIMIT) {
    const res = await pdFetch<Record<string, unknown>>(transport, path, {
      query: { ...query, limit: PAGE_LIMIT, offset },
    });
    const items = Array.isArray(res?.[key]) ? (res[key] as T[]) : [];
    out.push(...items);
    if (res?.["more"] !== true || items.length === 0) break;
  }
  return out;
}

export interface EventsApiBody {
  routing_key: string;
  event_action: "trigger" | "acknowledge" | "resolve";
  dedup_key: string;
  payload?: {
    summary: string;
    source: string;
    severity: "critical" | "error" | "warning" | "info";
    timestamp?: string;
    component?: string;
    group?: string;
    class?: string;
    custom_details?: Record<string, unknown>;
  };
  client?: string;
  client_url?: string;
  links?: Array<{ href: string; text: string }>;
}

/** One Events API v2 call. Returns the dedup key PagerDuty recorded. */
export async function sendEvent(
  transport: PagerDutyTransport,
  body: EventsApiBody,
): Promise<{ dedupKey: string }> {
  const { status, text } = await send(
    transport,
    eventsUrl(transport.region),
    "POST",
    { "Content-Type": "application/json", Accept: "application/json" },
    JSON.stringify(body),
  );
  if (status < 200 || status >= 300) throw describeError(status, text, "/v2/enqueue");
  try {
    const parsed = JSON.parse(text) as { dedup_key?: string };
    return { dedupKey: parsed.dedup_key ?? body.dedup_key };
  } catch {
    return { dedupKey: body.dedup_key };
  }
}
