import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch, utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * Tiger Cloud REST API (`https://console.cloud.tigerdata.com/public/api/v1`;
 * the older `console.cloud.timescale.com` host answers the same paths).
 * Verified 2026-10 against the OpenAPI document Tiger Data ships with its own
 * CLI (github.com/timescale/tiger-cli, `openapi.yaml`).
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

export async function tigerFetch<T>(
  ctx: TigerContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Array<[string, string | number | undefined]>,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of query ?? []) {
    if (v !== undefined && v !== "") params.append(k, String(v));
  }
  const qs = params.toString();
  try {
    return await jsonRestFetch<T>({
      vendor: "Tiger Cloud",
      url: `${ctx.baseUrl ?? TIGER_API}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${utf8ToBase64(`${ctx.accessKey}:${ctx.secretKey}`)}`,
      },
      init: {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new TigerApiError(status, friendlyError(status, message));
    throw err;
  }
}

/** Prefer the API's own `message` over the raw body. */
export function friendlyError(status: number, raw: string): string {
  if (status === 401) {
    return "Tiger Cloud API error 401: the access key or secret key was rejected. Create a new client credential under Project settings in the Tiger Cloud console.";
  }
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as { message?: string; details?: string };
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
