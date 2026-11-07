import { createApiClient, type ApiClient, type HttpHostServices } from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

/**
 * The Cohere Platform API, typed from Cohere's published OpenAPI document.
 *
 * The base URL is `https://api.cohere.com`, *not* `api.cohere.ai`, which only
 * survives on stale pages. Auth is `Authorization: Bearer <key>`, plus the
 * optional `X-Client-Name` header Cohere asks integrators to set.
 *
 * Note the version split: **management endpoints are still `/v1/`**. Only the
 * inference surface (chat, embed, rerank, transcriptions) and the newer batches
 * API live on `/v2/`. Do not "modernise" the `/v1/` paths: the `/v2/` equivalents
 * do not exist.
 */
export const BASE_URL = "https://api.cohere.com";

type Schemas = components["schemas"];

export type CohereModel = Schemas["GetModelResponse"];
export type CohereDataset = Schemas["Dataset"];
export type CohereFinetunedModel = Schemas["FinetunedModel"];
export type CohereEmbedJob = Schemas["EmbedJob"];
export type CohereBatch = Schemas["Batch"];

export type CheckApiKeyOperation = operations["checkAPIKey"];
export type CreateEmbedJobOperation = operations["create-embed-job"];
export type TranscriptionOperation = operations["create-transcription"];

export type CohereApi = ApiClient<paths>;

export function cohereHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    // Declared on every endpoint in Cohere's spec as "the name of the project
    // that is making the request". Their own SDKs set it.
    "X-Client-Name": "infrawrench",
  };
}

export function createCohereApi(
  apiKey: string,
  http: HttpHostServices | undefined,
  caCert: string | undefined,
): CohereApi {
  return createApiClient<paths>({
    vendor: "Cohere",
    baseUrl: BASE_URL,
    headers: cohereHeaders(apiKey),
    http,
    caCert,
  });
}
