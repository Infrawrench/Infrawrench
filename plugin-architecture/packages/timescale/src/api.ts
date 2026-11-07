import type { ApiClient, HttpHostServices } from "@infrawrench/plugin-base";
import { createApiClient, utf8ToBase64 } from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";

/**
 * Tiger Cloud REST API (`https://console.cloud.tigerdata.com/public/api/v1`;
 * the older `console.cloud.timescale.com` host answers the same paths).
 * Typed from the OpenAPI document Tiger Data ships with its own CLI
 * (github.com/timescale/tiger-cli, `openapi.yaml`); see `plugingen.json`.
 *
 * Auth is HTTP Basic with a project-scoped client credential (PAT):
 * `base64(<public key>:<secret key>)`. A PAT sees exactly one project.
 * Errors are `{ code, message }` JSON with a 4xx status.
 */
export const TIGER_API = "https://console.cloud.tigerdata.com/public/api/v1";

export interface TigerContext {
  accessKey: string;
  secretKey: string;
  http?: HttpHostServices;
  /** Overridable for tests. */
  baseUrl?: string;
}

/** Any non-2xx answer, carrying the status the poller classifies on. */
export class TigerApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TigerApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Tiger Cloud API error (\d{3})/;

export type TigerApi = ApiClient<paths>;

export function createTigerApi(ctx: TigerContext): TigerApi {
  return createApiClient<paths>({
    vendor: "Tiger Cloud",
    baseUrl: ctx.baseUrl ?? TIGER_API,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${utf8ToBase64(`${ctx.accessKey}:${ctx.secretKey}`)}`,
    },
    http: ctx.http,
    httpError: ({ status, path, body }) => {
      const message = `Tiger Cloud API error ${status} for ${path}: ${body}`;
      // Only a three-digit status counts, read back from the text it was always read from.
      const known = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
      return known ? new TigerApiError(known, friendlyError(known, message)) : new Error(message);
    },
  });
}

/** The document's error body, plus the `details` the API sends beside it. */
type ErrorBody = components["schemas"]["Error"] & { details?: string };

/** Prefer the API's own `message` over the raw body. */
export function friendlyError(status: number, raw: string): string {
  if (status === 401) {
    return "Tiger Cloud API error 401: the access key or secret key was rejected. Create a new client credential under Project settings in the Tiger Cloud console.";
  }
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed: ErrorBody = JSON.parse(raw.slice(jsonStart));
      if (parsed.message) {
        return `Tiger Cloud API error ${status}: ${parsed.message}${parsed.details ? ` (${parsed.details})` : ""}`;
      }
    } catch {
      /* not JSON */
    }
  }
  return raw;
}

export function statusOf(err: unknown): number {
  return err instanceof TigerApiError ? err.status : 0;
}

/**
 * Preview endpoints (backups, exporters, IP allow lists) are refused on plans
 * that do not include them; such a type lists empty rather than failing the
 * whole sync. Authentication failures still propagate.
 */
export function isUnavailable(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404 || s === 405 || s === 501;
}
