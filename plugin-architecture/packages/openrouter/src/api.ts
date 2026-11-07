import {
  createApiClient,
  type ApiBody,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

export const BASE_URL = "https://openrouter.ai/api/v1";

export type OrModel = ApiListItem<operations["getModels"], "data">;
/** `GET /models/{author}/{slug}/endpoints`: a model's identity and all of its endpoints. */
export type OrModelDetail = ApiResponse<operations["listEndpoints"]>["data"];
/**
 * What the model mapper reads. A catalogue row has all of it, and the detail
 * answer above only `id`, `name`, `created`, `description` and `architecture`.
 */
export type OrModelFields = Pick<OrModel, "id"> & Partial<Omit<OrModel, "id" | "endpoints">>;
export type OrEndpoint = OrModelDetail["endpoints"][number];
export type OrProvider = ApiListItem<operations["listProviders"], "data">;
export type OrKey = ApiListItem<operations["list"], "data">;
export type OrActivityItem = ApiListItem<operations["getUserActivity"], "data">;
export type OrGuardrail = ApiListItem<operations["listGuardrails"], "data">;
export type OrGuardrailKeyAssignment = ApiListItem<
  operations["listGuardrailKeyAssignments"],
  "data"
>;
export type OrWorkspace = ApiListItem<operations["listWorkspaces"], "data">;
export type OrWorkspaceBudgets = ApiResponse<operations["listWorkspaceBudgets"]>;
export type OrByokCredential = ApiListItem<operations["listBYOKKeys"], "data">;
export type OrCredits = ApiResponse<operations["getCredits"]>;
/** `{}` stands in for a performance query that failed or was not run. */
export type OrAnalyticsAnswer = Partial<ApiResponse<operations["queryAnalytics"]>>;
export type OrAnalyticsFilter = components["schemas"]["Filter"];
export type OrTranscription = ApiResponse<operations["createAudioTranscriptions"]>;

export type OrKeyCreate = ApiBody<operations["createKeys"]>;
export type OrKeyUpdate = ApiBody<operations["updateKeys"]>;
export type OrGuardrailUpdate = ApiBody<operations["updateGuardrail"]>;
export type OrWorkspaceUpdate = ApiBody<operations["updateWorkspace"]>;
export type OrByokUpdate = ApiBody<operations["updateBYOKKey"]>;
export type OrSpeechRequest = ApiBody<operations["createAudioSpeech"]>;
export type OrTranscriptionRequest = ApiBody<operations["createAudioTranscriptions"]>;

/**
 * One client per key, because OpenRouter takes different keys on different
 * routes: see `OpenRouterClient`.
 */
export function createOpenRouterApi(options: {
  key: string;
  caCert: string | undefined;
  http: HttpHostServices | undefined;
}) {
  return createApiClient<paths>({
    vendor: "OpenRouter",
    baseUrl: BASE_URL,
    headers: { Authorization: `Bearer ${options.key}`, Accept: "application/json" },
    caCert: options.caCert,
    http: options.http,
  });
}

export type OpenRouterApi = ReturnType<typeof createOpenRouterApi>;
