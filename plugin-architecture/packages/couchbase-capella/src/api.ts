import {
  createApiClient,
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
    vendor: "Capella",
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

/**
 * Walk `page`/`perPage` until `cursor.pages.last`, up to 50 pages. A hand loop,
 * because this one runs on past a short page and `getAll` would read a `data` that
 * is not a list as an empty one, and an empty list is what the host prunes on.
 */
export async function capellaList<Row>(
  fetchPage: (query: { page: number; perPage: number }) => Promise<Page<Row> | undefined>,
  maxPages = 50,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage({ page, perPage: 100 });
    out.push(...(res?.data ?? []));
    const last = res?.cursor?.pages?.last ?? page;
    if (page >= last || !(res?.data ?? []).length) break;
  }
  return out;
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
