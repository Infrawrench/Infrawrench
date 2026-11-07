/**
 * The part of xAI's inference API that its OpenAPI document describes: models,
 * files and skills on `https://api.x.ai`. The document leaves out batches, voices,
 * speech and the whole management host, so those calls stay hand-written in
 * `client.ts`.
 *
 * Docs: https://docs.x.ai/openapi.json
 */
import { createApiClient, type ApiClient, type HttpHostServices } from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

export const INFERENCE_BASE = "https://api.x.ai";

export type InferenceApi = ApiClient<paths>;

/** A non-2xx answer from either xAI host, with its message unchanged and its status readable. */
export class XaiApiError extends Error {
  readonly status: number;

  constructor(vendor: string, status: number, path: string, body: string) {
    super(`${vendor} API error ${status} for ${path}: ${body}`);
    this.name = "XaiApiError";
    this.status = status;
  }
}

/**
 * The key may not read this route, so for it there is nothing to list. Anything else, a
 * 429, a 5xx or an unreadable body, says nothing about what exists.
 */
export function keyCannotRead(err: unknown): boolean {
  return err instanceof XaiApiError && [401, 403, 404].includes(err.status);
}

export function createInferenceApi(options: {
  apiKey: string;
  caCert?: string | undefined;
  http?: HttpHostServices | undefined;
}): InferenceApi {
  const { apiKey, caCert, http } = options;
  return createApiClient<paths>({
    vendor: "xAI",
    baseUrl: INFERENCE_BASE,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    caCert,
    http,
    httpError: ({ status, target, body }) => new XaiApiError("xAI", status, target, body),
  });
}
