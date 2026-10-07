import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Aiven REST API v1 (`https://api.aiven.io/v1`, OpenAPI document at
 * `https://api.aiven.io/doc/openapi.json`; verified 2026-10).
 *
 * Auth is `Authorization: aivenv1 <token>` (the spec also accepts `Bearer`).
 * Tokens come from the console's User profile, Tokens page (personal) or an
 * application user (organisation). Errors are
 * `{ "errors": [{ "message", "status" }], "message" }`. The API sends CORS
 * headers for any origin.
 */
export const AIVEN_API = "https://api.aiven.io/v1";

export interface AivenContext {
  token: string;
  caCert?: string;
  http?: HttpHostServices;
  baseUrl?: string;
}

export class AivenApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AivenApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof AivenApiError ? err.status : 0;
}

export type Query = Record<string, string | number | boolean | undefined>;

const STATUS_IN_MESSAGE = /Aiven API error (\d{3})/;

export function friendlyError(status: number, raw: string): string {
  let detail = raw.replace(/^Aiven API error \d{3} for [^:]*: /, "");
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(detail.slice(jsonStart)) as {
        message?: string;
        errors?: Array<{ message?: string }>;
      };
      detail = parsed.message ?? parsed.errors?.[0]?.message ?? detail;
    } catch {
      /* keep text */
    }
  }
  const hint =
    status === 401
      ? " Check the token in Aiven (User profile, Tokens); tokens can expire after their maximum age or idle timeout."
      : status === 403
        ? " The token's user lacks the project or organisation permission for this."
        : "";
  return `Aiven API error ${status}: ${detail.trim() || "(empty)"}${hint}`;
}

export async function aivenFetch<T>(
  ctx: AivenContext,
  method: string,
  path: string,
  options: { body?: unknown; query?: Query } = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  try {
    return await jsonRestFetch<T>({
      vendor: "Aiven",
      url: `${ctx.baseUrl ?? AIVEN_API}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: { Accept: "application/json", Authorization: `aivenv1 ${ctx.token}` },
      init: {
        method,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      ...(ctx.http ? { http: ctx.http } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new AivenApiError(status, friendlyError(status, message));
    throw err;
  }
}

export const enc = encodeURIComponent;
