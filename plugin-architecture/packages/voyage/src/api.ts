import {
  createApiClient,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/** Voyage API v1. */
export const API_BASE = "https://api.voyageai.com/v1";

export type VoyageApi = ApiClient<paths>;

/** An operation's response, by its `operationId`. */
export type VoyageResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type Batch = VoyageResponse<"retrieve-batch">;
export type VoyageFile = VoyageResponse<"retrieve-file">;

/** `limit` and `after`, which batches and files page by alike. */
export interface PageQuery {
  limit: number;
  after?: string;
}

export function createVoyageApi(options: {
  apiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}): VoyageApi {
  const { apiKey, caCert, http } = options;
  return createApiClient<paths>({
    vendor: "Voyage AI",
    baseUrl: API_BASE,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    encodeQuery: encodeURIComponent,
    // Errors have always named the path without its query.
    httpError: ({ status, path, body }) =>
      new Error(`Voyage AI API error ${status} for ${path}: ${body}`),
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  });
}
