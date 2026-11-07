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
  });
}
