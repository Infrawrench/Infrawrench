import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  type ApiBody,
  type ApiClient,
  type ApiFailure,
  type ApiResponse,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/**
 * Couchbase Capella Management API v4 (`https://cloudapi.cloud.couchbase.com`).
 * Types come from its OpenAPI document (`plugingen.json`), the same source the
 * `couchbasecloud/couchbase-capella` Terraform provider generates its client
 * from. Auth is `Authorization: Bearer <API key token>`; a key belongs to one
 * organization and carries organization and project roles. The documented limit
 * is 100 requests a minute per key.
 */
export const CAPELLA_API = "https://cloudapi.cloud.couchbase.com";
const VENDOR = "Capella";

export type CapellaApi = ApiClient<paths>;

/** The JSON body an operation takes, for one built up field by field. */
export type CapellaBody<Op extends keyof operations> = ApiBody<operations[Op]>;

/** An operation's response, by its `operationId`. */
export type CapellaResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

/** One row of an operation's `data` list, by its `operationId`. */
export type CapellaRow<Op extends keyof operations> =
  CapellaResponse<Op> extends { data: ReadonlyArray<infer Row> } ? Row : never;

export type OrgPath = `/v4/organizations/${NoSlashString}`;
export type ProjectPath = `${OrgPath}/projects/${NoSlashString}`;
export type ClusterPath = `${ProjectPath}/clusters/${NoSlashString}`;
export type FreeClusterPath = `${ProjectPath}/clusters/freeTier/${NoSlashString}`;

export interface CapellaContext {
  apiKey: string;
  organizationId: string;
  http?: HttpHostServices;
  baseUrl?: string;
}

export class CapellaApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CapellaApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Capella API error (\d{3})/;

export function statusOf(err: unknown): number {
  return err instanceof CapellaApiError ? err.status : 0;
}

export function isUnavailable(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404 || s === 422;
}

function friendly(status: number, raw: string): string {
  if (status === 401) {
    return "Capella API error 401: the API key was rejected or has expired. Create a new one under Organization Settings, API Keys in the Capella UI.";
  }
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const parsed: { message?: string; hint?: string } = JSON.parse(raw.slice(start));
      if (parsed.message) {
        return `Capella API error ${status}: ${parsed.message}${parsed.hint ? ` ${parsed.hint}` : ""}`;
      }
    } catch {
      /* not JSON */
    }
  }
  return raw;
}

/** What a non-2xx answer throws. The status comes out of the same text the message is built from. */
function capellaError({ status, path, body }: ApiFailure): Error {
  const raw = `Capella API error ${status} for ${path}: ${body}`;
  const parsed = Number(STATUS_IN_MESSAGE.exec(raw)?.[1] ?? 0);
  return parsed ? new CapellaApiError(parsed, friendly(parsed, raw)) : new Error(raw);
}

export function createCapellaApi(
  ctx: Pick<CapellaContext, "apiKey" | "http" | "baseUrl">,
): CapellaApi {
  return createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: ctx.baseUrl ?? CAPELLA_API,
    headers: { Accept: "application/json", Authorization: `Bearer ${ctx.apiKey}` },
    http: ctx.http,
    httpError: capellaError,
  });
}

interface Page<Row> {
  data?: Row[];
  cursor?: { pages?: { page?: number; last?: number } };
}

// The document gives no maximum for `perPage`, so this stays the size already sent.
const PER_PAGE = 100;
const MAX_PAGES = 100;

/**
 * Walk `page`/`perPage` until `cursor.pages.last`, up to 10,000 rows. A hand loop,
 * because `last` is what this has always ended on, and `getAll` would end on a short
 * page, `next` or `totalItems` instead, none of them checked against a live answer.
 */
export async function capellaList<Path extends string, Row>(
  path: Path,
  fetchPage: (
    path: Path,
    query: { page: number; perPage: number },
  ) => Promise<Page<Row> | undefined>,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchPage(path, { page, perPage: PER_PAGE });
    const rows = requireListPage(res?.data, { vendor: VENDOR, path, key: "data", page: res });
    out.push(...rows);
    if (page >= (res?.cursor?.pages?.last ?? page) || !rows.length) return out;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages: MAX_PAGES });
}

/** The list in an answer from a route with no paging, which answers all of it at once. */
export function rowsAt<Key extends string, Row>(
  path: string,
  key: Key,
  answer: { readonly [K in Key]?: readonly Row[] } | undefined,
): Row[] {
  return requireListPage(answer?.[key], { vendor: VENDOR, path, key, page: answer });
}

/** Composite external ids: each part URI-encoded (bucket ids are base64 and may hold `/`). */
export function joinId(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

export function splitId(externalId: string, count: 2): [string, string];
export function splitId(externalId: string, count: 3): [string, string, string];
export function splitId(externalId: string, count: 4): [string, string, string, string];
export function splitId(externalId: string, count: 5): [string, string, string, string, string];
export function splitId(externalId: string, count: number): string[] {
  const parts = externalId.split("/").map((p) => decodeURIComponent(p));
  if (parts.length !== count || parts.some((p) => !p)) {
    throw new Error(`Capella plugin: malformed id "${externalId}"`);
  }
  return parts;
}
