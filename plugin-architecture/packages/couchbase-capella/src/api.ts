import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Couchbase Capella Management API v4 (`https://cloudapi.cloud.couchbase.com`).
 * Verified 2026-10 against the OpenAPI document embedded in
 * docs.couchbase.com/cloud/management-api-reference/index.html (the same
 * source the `couchbasecloud/couchbase-capella` Terraform provider generates
 * its client from). Auth is `Authorization: Bearer <API key token>`; a key
 * belongs to one organization and carries organization and project roles.
 * The documented limit is 100 requests a minute per key.
 */
export const CAPELLA_API = "https://cloudapi.cloud.couchbase.com";

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
      const parsed = JSON.parse(raw.slice(start)) as {
        message?: string;
        hint?: string;
        code?: number;
      };
      if (parsed.message) {
        return `Capella API error ${status}: ${parsed.message}${parsed.hint ? ` ${parsed.hint}` : ""}`;
      }
    } catch {
      /* not JSON */
    }
  }
  return raw;
}

export async function capellaFetch<T>(
  ctx: Pick<CapellaContext, "apiKey" | "http" | "baseUrl">,
  method: string,
  path: string,
  body?: unknown,
  query?: Array<[string, string | number | undefined]>,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of query ?? []) if (v !== undefined && v !== "") params.append(k, String(v));
  const qs = params.toString();
  try {
    return await jsonRestFetch<T>({
      vendor: "Capella",
      url: `${ctx.baseUrl ?? CAPELLA_API}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: { Accept: "application/json", Authorization: `Bearer ${ctx.apiKey}` },
      init: { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new CapellaApiError(status, friendly(status, message));
    throw err;
  }
}

interface Page<T> {
  data?: T[];
  cursor?: { pages?: { page?: number; last?: number } };
}

/** Walk `page`/`perPage` until `cursor.pages.last`. */
export async function capellaList<T>(
  ctx: Pick<CapellaContext, "apiKey" | "http" | "baseUrl">,
  path: string,
  query: Array<[string, string | number | undefined]> = [],
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await capellaFetch<Page<T>>(ctx, "GET", path, undefined, [
      ...query,
      ["page", page],
      ["perPage", 100],
    ]);
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

export function splitId(externalId: string, count: number): string[] {
  const parts = externalId.split("/").map((p) => decodeURIComponent(p));
  if (parts.length !== count || parts.some((p) => !p)) {
    throw new Error(`Capella plugin: malformed id "${externalId}"`);
  }
  return parts;
}
