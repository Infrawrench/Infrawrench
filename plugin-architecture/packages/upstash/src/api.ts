import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch, utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * Two Upstash APIs, verified 2026-10 against the published OpenAPI documents
 * (`https://upstash.com/docs/devops/developer-api/openapi.yaml` and
 * `https://upstash.com/docs/qstash/openapi.yaml`):
 *
 * - **Developer API** `https://api.upstash.com/v2`: HTTP Basic auth with the
 *   account email and a Developer API key (Console, Account, Developer API).
 *   Manages Redis databases, Vector and Search indexes, QStash accounts,
 *   teams and the audit log. Only native Upstash accounts can use it; accounts
 *   created through Vercel or Fly.io cannot.
 * - **QStash API** `https://qstash-{region}.upstash.io/v2`: Bearer auth with
 *   the QStash token of one regional QStash account. The Developer API hands
 *   those tokens out in `GET /qstash/users`, so the user never types one.
 *
 * Errors are plain text or `{ "error": "..." }`.
 */
export const DEVELOPER_API = "https://api.upstash.com/v2";

export function qstashBase(region: string | undefined): string {
  return `https://qstash-${region || "eu-central-1"}.upstash.io`;
}

export interface UpstashContext {
  email: string;
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
  /** Overridable for tests. */
  baseUrl?: string;
  qstashBaseUrl?: (region: string | undefined) => string;
}

export class UpstashApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UpstashApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof UpstashApiError ? err.status : 0;
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export function buildQuery(query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

const STATUS_IN_MESSAGE = /API error (\d{3})/;

function rethrow(err: unknown, vendor: string): never {
  const message = err instanceof Error ? err.message : String(err);
  const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
  if (!status) throw err;
  let detail = message.replace(/^.*?: /, "");
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(detail.slice(jsonStart)) as { error?: string; message?: string };
      detail = parsed.error ?? parsed.message ?? detail;
    } catch {
      /* keep text */
    }
  }
  const hint =
    status === 401
      ? vendor === "Upstash"
        ? " Check the email and Developer API key, and that the account was created on upstash.com (Vercel and Fly.io accounts cannot use the Developer API)."
        : " The QStash token was rejected; reset it from the QStash account if it was rotated elsewhere."
      : status === 403
        ? " The key is read-only or lacks access to this resource."
        : "";
  throw new UpstashApiError(
    status,
    `${vendor} API error ${status}: ${detail.trim() || "(empty)"}${hint}`,
  );
}

/** Developer API request (Basic auth). */
export async function devFetch<T>(
  ctx: UpstashContext,
  method: string,
  path: string,
  options: { body?: unknown; query?: Query } = {},
): Promise<T> {
  try {
    return await jsonRestFetch<T>({
      vendor: "Upstash",
      url: `${ctx.baseUrl ?? DEVELOPER_API}${path}${buildQuery(options.query)}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${utf8ToBase64(`${ctx.email}:${ctx.apiKey}`)}`,
      },
      init: {
        method,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      ...(ctx.http ? { http: ctx.http } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
  } catch (err) {
    // A few writes answer 200 with a bare "OK" rather than JSON.
    if (err instanceof SyntaxError) return undefined as T;
    rethrow(err, "Upstash");
  }
}

/** QStash API request (Bearer QStash token of one regional account). */
export async function qstashFetch<T>(
  ctx: UpstashContext,
  account: { token: string; region?: string | undefined },
  method: string,
  path: string,
  options: { body?: string; json?: unknown; query?: Query; headers?: Record<string, string> } = {},
): Promise<T> {
  const base = (ctx.qstashBaseUrl ?? qstashBase)(account.region);
  const body =
    options.json !== undefined
      ? JSON.stringify(options.json)
      : options.body !== undefined
        ? options.body
        : undefined;
  try {
    return await jsonRestFetch<T>({
      vendor: "QStash",
      url: `${base}${path}${buildQuery(options.query)}`,
      errorPath: path,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${account.token}`,
        ...(options.headers ?? {}),
      },
      init: { method, ...(body !== undefined ? { body } : {}) },
      ...(ctx.http ? { http: ctx.http } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
  } catch (err) {
    if (err instanceof SyntaxError) return undefined as T;
    rethrow(err, "QStash");
  }
}
