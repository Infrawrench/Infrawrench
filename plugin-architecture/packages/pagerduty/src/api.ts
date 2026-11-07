/**
 * PagerDuty transports: the REST API v2 and the Events API v2.
 *
 * Verified against the REST API OpenAPI document
 * (github.com/PagerDuty/api-schema, reference/REST/openapiv3.json) and
 * developer docs (docs.pagerduty.com/developer, 2026-10):
 *
 * - REST: `https://api.pagerduty.com` (EU service region:
 *   `https://api.eu.pagerduty.com`). `Authorization: Token token=<key>` for a
 *   REST API key, `Authorization: Bearer <token>` for an OAuth access token
 *   (Connect with PagerDuty; tokens start `pdus+_`),
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
import {
  createApiClient,
  withCursorPagination,
  type ApiBody,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type {
  operations as eventsOperations,
  paths as eventsPaths,
} from "./api-types.events.gen.js";
import type { paths } from "./api-types.rest.gen.js";

export type PagerDutyRegion = "us" | "eu";

export function restBase(region: PagerDutyRegion): string {
  return region === "eu" ? "https://api.eu.pagerduty.com" : "https://api.pagerduty.com";
}

export function eventsBase(region: PagerDutyRegion): string {
  return region === "eu" ? "https://events.eu.pagerduty.com/v2" : "https://events.pagerduty.com/v2";
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

/** How many pages a list walks by default: 2000 rows. */
const MAX_PAGES = 20;

export interface PagerDutyTransport {
  apiKey: string;
  /** Send the key as an OAuth Bearer token instead of `Token token=`. */
  bearer?: boolean;
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

function describeError(status: number, text: string, path: string): PagerDutyApiError {
  let message = text;
  let code: number | undefined;
  try {
    const parsed: {
      error?: { message?: string; code?: number; errors?: string[] };
      message?: string;
      errors?: string[];
    } = JSON.parse(text);
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
      ? " Check the API key (Integrations, API Access Keys in PagerDuty), or reconnect the account if it was connected with PagerDuty."
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

/** The REST API, with `getAll` walking its offset-paged lists. */
export function createPagerDutyApi(transport: PagerDutyTransport) {
  const client = createApiClient<paths>({
    vendor: "PagerDuty",
    baseUrl: restBase(transport.region),
    headers: {
      Accept: "application/vnd.pagerduty+json;version=2",
      Authorization: transport.bearer
        ? `Bearer ${transport.apiKey}`
        : `Token token=${transport.apiKey}`,
    },
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    http: transport.http,
    caCert: transport.caCert,
    httpError: ({ status, body, path }) => describeError(status, body, path),
  });
  return withCursorPagination(client, {
    cursorParam: "offset",
    firstCursor: 0,
    sizeParam: "limit",
    pageSize: PAGE_LIMIT,
    maxPages: MAX_PAGES,
    // A body with no list ends the walk rather than failing it.
    emptyBodyEndsList: true,
    // Only a literal `more: true` asks for another page, and the offset moves by
    // the page size whatever the page held.
    next: ({ body, cursor }) =>
      typeof body === "object" && body !== null && "more" in body && body.more === true
        ? Number(cursor) + PAGE_LIMIT
        : undefined,
  });
}

export type PagerDutyApi = ReturnType<typeof createPagerDutyApi>;

/** The Events API: no auth header, because the routing key in the body is the credential. */
export function createPagerDutyEvents(transport: PagerDutyTransport) {
  return createApiClient<eventsPaths>({
    vendor: "PagerDuty",
    baseUrl: eventsBase(transport.region),
    headers: { Accept: "application/json" },
    emptyBodyIsUndefined: true,
    http: transport.http,
    caCert: transport.caCert,
    httpError: ({ status, body, path }) => describeError(status, body, `/v2${path}`),
  });
}

export type PagerDutyEvents = ReturnType<typeof createPagerDutyEvents>;

export type EventsApiBody = ApiBody<eventsOperations["createV2Event"]> & { dedup_key: string };

/** One Events API v2 call. Returns the dedup key PagerDuty recorded. */
export async function sendEvent(
  events: PagerDutyEvents,
  body: EventsApiBody,
): Promise<{ dedupKey: string }> {
  try {
    const answer = await events.post("/enqueue", { body });
    return { dedupKey: answer?.dedup_key ?? body.dedup_key };
  } catch (err) {
    // The event was accepted; a 2xx that is not JSON only costs PagerDuty's key.
    if (err instanceof SyntaxError) return { dedupKey: body.dedup_key };
    throw err;
  }
}
