import {
  createApiClient,
  pathEncode,
  requireListPage,
  type ApiBody,
  type ApiClient,
  type ApiFailure,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/**
 * Aiven REST API v1 (`https://api.aiven.io/v1`, OpenAPI document at
 * `https://api.aiven.io/doc/openapi.json`; verified 2026-10).
 *
 * Auth is `Authorization: aivenv1 <token>` (the spec also accepts `Bearer`).
 * Tokens come from the console's User profile, Tokens page (personal) or an
 * application user (organisation). Errors are
 * `{ "errors": [{ "message", "status" }], "message" }`. The API sends CORS
 * headers for any origin. Nothing the plugin lists is paged. Types come from that
 * document (`plugingen.json`).
 */
export const AIVEN_API = "https://api.aiven.io/v1";

export type AivenApi = ApiClient<paths>;

/** The JSON body an operation takes, for one built up field by field. */
export type AivenBody<Op extends keyof operations> = ApiBody<operations[Op]>;

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

const STATUS_IN_MESSAGE = /Aiven API error (\d{3})/;

export function friendlyError(status: number, raw: string): string {
  let detail = raw.replace(/^Aiven API error \d{3} for [^:]*: /, "");
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed: { message?: string; errors?: Array<{ message?: string }> } = JSON.parse(
        detail.slice(jsonStart),
      );
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

/** What a non-2xx answer throws. The status comes out of the same text the message is built from. */
function aivenError({ status, path, body }: ApiFailure): Error {
  const raw = `Aiven API error ${status} for ${path}: ${body}`;
  const parsed = Number(STATUS_IN_MESSAGE.exec(raw)?.[1] ?? 0);
  return parsed ? new AivenApiError(parsed, friendlyError(parsed, raw)) : new Error(raw);
}

export function createAivenApi(ctx: AivenContext): AivenApi {
  return createApiClient<paths>({
    vendor: "Aiven",
    baseUrl: ctx.baseUrl ?? AIVEN_API,
    headers: { Accept: "application/json", Authorization: `aivenv1 ${ctx.token}` },
    http: ctx.http,
    caCert: ctx.caCert,
    httpError: aivenError,
  });
}

export const enc = pathEncode;

/** A list the document requires, so a 2xx without it is not an empty answer. */
export function listOf<T>(list: readonly T[] | null | undefined, path: string, key: string): T[] {
  return requireListPage(list, { vendor: "Aiven", path, key });
}
