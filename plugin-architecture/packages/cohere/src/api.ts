import {
  createApiClient,
  withCursorPagination,
  type ApiClient,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
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

/** 1,000 is the most `/v1/models` and `/v2/batches` document, so 20 pages is 20,000 rows. */
const LARGEST_PAGE = { pageSize: 1000, maxPages: 20 };

/** The document gives `/v1/finetuning/*` no largest page: 10,000 rows at the size always sent. */
export const FINETUNE_PAGES = { pageSize: 100, maxPages: 100 };

/** The document gives `limit` no maximum: 10,000 rows at the size always sent. */
const DATASET_PAGE_SIZE = 100;
const DATASET_MAX_PAGES = 100;

const TOKEN_PAGES = {
  cursorParam: "page_token",
  sizeParam: "page_size",
  next: "next_page_token",
  // The document ends these lists on an empty or absent `next_page_token`, so a page
  // with no rows and a token still has more behind it.
  continueOnEmptyPage: true,
} as const;

export function cohereLists(api: CohereApi) {
  return {
    /** The document requires `models`, so a page without it is not a page of models. */
    models: withCursorPagination(api, { ...TOKEN_PAGES, ...LARGEST_PAGE }),
    /**
     * The document requires no other list key, and the fine-tuning and batch schemas
     * are proto3 (`STATUS_UNSPECIFIED`), whose JSON leaves an empty repeated field out.
     */
    tokens: withCursorPagination(api, {
      ...TOKEN_PAGES,
      ...LARGEST_PAGE,
      missingListIsEmpty: true,
    }),
    /** `limit`/`offset`, with no total and no token. The document does not require `datasets`. */
    datasets: withCursorPagination(api, {
      cursorParam: "offset",
      firstCursor: 0,
      sizeParam: "limit",
      pageSize: DATASET_PAGE_SIZE,
      maxPages: DATASET_MAX_PAGES,
      next: ({ cursor }) => Number(cursor) + DATASET_PAGE_SIZE,
      stopOnShortPage: true,
      missingListIsEmpty: true,
    }),
  };
}
