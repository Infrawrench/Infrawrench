import {
  createApiClient,
  requireListPage,
  withCursorPagination,
  type ApiClient,
  type HostServices,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";
import type { BSandbox } from "./types.js";

/**
 * Transport for the boat Public API v1 (`https://boat.dev/api/v1`, OpenAPI 3.1
 * at `https://docs.boat.dev/openapi/boat-v1.yaml`, checked 2026-11). Auth is
 * `Authorization: Bearer <key>`, keys start `boat_` (older `box_` keys still
 * work). Every success carries `ok: true` and a `type` discriminator; every
 * failure is `{ok: false, status, code, message, error: {...}, requestId}`.
 *
 * An organization is chosen with the `X-Boat-Org` header (an org id `team_…`
 * or its name); without it the account's active wallet applies. The header is
 * sent on every call when the account names an org, because list, create and
 * limits all read it, and the other routes act on ids the org already owns.
 *
 * Goes through `services.http` when the host provides it (bastion routing,
 * custom CA); plain `fetch` otherwise.
 */

export const API_BASE = "https://boat.dev/api/v1";

export class BoatApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    const parsed = parseError(body);
    super(`boat API error ${status} for ${path}: ${parsed.message}`);
    this.name = "BoatApiError";
    this.status = status;
    this.code = parsed.code;
    this.body = body;
  }
}

export function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: {
      code?: string;
      message?: string;
      error?: { code?: string; message?: string } | string;
    } = JSON.parse(body);
    const nested = typeof parsed.error === "object" && parsed.error ? parsed.error : undefined;
    const code = parsed.code ?? nested?.code ?? "";
    const message =
      parsed.message ?? nested?.message ?? (typeof parsed.error === "string" ? parsed.error : "");
    if (message || code) return { code, message: message || code };
  } catch {
    /* not JSON */
  }
  return { code: "", message: body.slice(0, 500) || "(empty response)" };
}

export type BoatApi = ApiClient<paths>;

export function createBoatApi(
  apiKey: string,
  org: string,
  caCert: string,
  services: HostServices | undefined,
): BoatApi {
  return createApiClient<paths>({
    vendor: "boat",
    baseUrl: API_BASE,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(org ? { "X-Boat-Org": org } : {}),
    },
    http: services?.http,
    caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError: ({ status, path, body }) => new BoatApiError(status, path, body ?? ""),
  });
}

/**
 * Every sandbox the key can see. `include=cost` adds each one's machine time
 * this calendar month (UTC) at list price, which the inventory shows and the
 * cost pass does not rely on.
 */
export function listSandboxes(api: BoatApi, withCost = true): Promise<BSandbox[]> {
  return withCursorPagination(api, {
    cursorParam: "cursor",
    sizeParam: "limit",
    pageSize: 200,
    next: "pageInfo.nextCursor",
    hasMore: "pageInfo.hasMore",
    maxPages: 100,
  }).getAll("/sandboxes", "sandboxes", withCost ? { query: { include: "cost" } } : {});
}

/**
 * The rows of an unpaged list route. A body without the list throws instead of
 * reading as none, which a sync would prune everything on.
 */
export function listOf<T>(rows: T[] | undefined, path: string, key: string): T[] {
  return requireListPage(rows, { vendor: "boat", path, key });
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof BoatApiError && statuses.includes(err.status);
}
