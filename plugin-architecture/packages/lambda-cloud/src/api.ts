import {
  createApiClient,
  withCursorPagination,
  type ApiClient,
  type HostServices,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";
import type { LInstance } from "./types.js";

/**
 * Transport for the Lambda Cloud API (`https://cloud.lambda.ai/api/v1`,
 * OpenAPI 1.10.0 at `/api/v1/openapi.json`, checked 2026-10). Auth is
 * `Authorization: Bearer <key>`. Every success is wrapped as `{data}`, every
 * failure as `{error: {code, message, suggestion?}}`. Lambda documents a rate
 * limit of one request per second (one launch per 12 seconds).
 *
 * Goes through `services.http` when the host provides it (bastion routing,
 * custom CA); plain `fetch` otherwise.
 */

export const API_BASE = "https://cloud.lambda.ai/api/v1";

export class LambdaApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    const parsed = parseError(body);
    super(
      `Lambda Cloud API error ${status} for ${path}: ${parsed.message}${parsed.suggestion ? ` (${parsed.suggestion})` : ""}`,
    );
    this.name = "LambdaApiError";
    this.status = status;
    this.code = parsed.code;
    this.body = body;
  }
}

export function parseError(body: string): { code: string; message: string; suggestion: string } {
  try {
    const parsed: { error?: { code?: string; message?: string; suggestion?: string } } =
      JSON.parse(body);
    const e = parsed.error;
    if (e && (e.message || e.code)) {
      return {
        code: e.code ?? "",
        message: e.message || e.code || "",
        suggestion: e.suggestion ?? "",
      };
    }
  } catch {
    /* not JSON */
  }
  return { code: "", message: body.slice(0, 500) || "(empty response)", suggestion: "" };
}

export type LambdaApi = ApiClient<paths>;

export function createLambdaApi(
  apiKey: string,
  caCert: string,
  services: HostServices | undefined,
): LambdaApi {
  return createApiClient<paths>({
    vendor: "Lambda Cloud",
    baseUrl: API_BASE,
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    http: services?.http,
    caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError: ({ status, path, body }) => new LambdaApiError(status, path, body ?? ""),
  });
}

/**
 * What a call answered inside `{data}`. A 2xx with no body arrives as `undefined`
 * and stays that way, which the document does not allow for and callers guard with
 * `??`. A body of JSON `null` is not that, and throws.
 */
export function unwrap<T>(answer: { data: T }): T {
  return answer === undefined ? answer : answer.data;
}

/** Every instance. `/instances` is the only list here that pages. */
export function listInstances(api: LambdaApi): Promise<LInstance[]> {
  return withCursorPagination(api, {
    cursorParam: "page_token",
    sizeParam: "page_size",
    pageSize: 100,
    next: "page_token",
    maxPages: 100,
    // The document ends a list only by a null `page_token`, so a token after an empty
    // page still means more rows.
    continueOnEmptyPage: true,
  }).getAll("/instances", "data");
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof LambdaApiError && statuses.includes(err.status);
}
