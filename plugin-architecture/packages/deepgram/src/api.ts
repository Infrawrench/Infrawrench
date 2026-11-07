import {
  createApiClient,
  type ApiBody,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

const BASE_URL = "https://api.deepgram.com";
/** The Voice Agent API's own host, where the managed think-model list lives. */
const AGENT_HOST = "https://agent.deepgram.com";

const THINK_MODELS = "/v1/agent/settings/think/models";

/** Everything but the think-model list, which only answers on the agent host. */
type ManagementPaths = Omit<paths, typeof THINK_MODELS>;
type AgentPaths = Pick<paths, typeof THINK_MODELS>;

/**
 * Auth is `Authorization: Token <key>`: Deepgram does **not** accept `Bearer`.
 * Routed through the host's HTTP service whenever one is present: that is the
 * only path that picks up bastion egress routing and a custom CA.
 */
export function createDeepgramApis(options: {
  apiKey: string;
  caCert?: string | undefined;
  http?: HttpHostServices | undefined;
}) {
  const shared = {
    vendor: "Deepgram",
    headers: { Authorization: `Token ${options.apiKey}`, Accept: "application/json" },
    caCert: options.caCert,
    http: options.http,
  };
  return {
    api: createApiClient<ManagementPaths>({ ...shared, baseUrl: BASE_URL }),
    agentApi: createApiClient<AgentPaths>({ ...shared, baseUrl: AGENT_HOST }),
  };
}

export type DeepgramApi = ReturnType<typeof createDeepgramApis>["api"];

/** Named by the widest response: `mip_opt_out` only comes from a single read. */
export type DgProject = ApiResponse<operations["projects_get"]>;

/**
 * A key from any of its three reads. Only the create response carries the
 * secret, and the list omits `tags` and `expiration_date`.
 */
export type DgApiKey = ApiListItem<operations["keys_list"], "api_keys">["api_key"] &
  Pick<ApiResponse<operations["keys_create"]>, "key" | "tags" | "expiration_date">;

export type DgApiKeyEntry = Omit<ApiListItem<operations["keys_list"], "api_keys">, "api_key"> & {
  api_key: DgApiKey;
};

export type DgMember = ApiListItem<operations["members_list"], "members">;
export type DgInvite = ApiListItem<operations["invites_list"], "invites">;
export type DgBalance = ApiListItem<operations["balances_list"], "balances">;
export type DgModelList = ApiResponse<operations["models_list_2"]>;

/** A transcription model or a voice: only voices have `metadata`, only models `batch`. */
export type DgModel = ApiListItem<operations["models_list_2"], "stt"> &
  ApiListItem<operations["models_list_2"], "tts">;

/** One bucket of the usage breakdown. Its timestamps are on `grouping`, not the top level. */
export type DgUsageBucket = ApiListItem<operations["breakdown_get"], "results">;

/** The usage breakdown's own filters, on top of the date range. */
export type UsageFilters = Pick<
  NonNullable<operations["breakdown_get"]["parameters"]["query"]>,
  "grouping" | "accessor" | "model"
>;

export type RequestFilters = Pick<
  NonNullable<operations["requests_list"]["parameters"]["query"]>,
  "status" | "endpoint"
>;

export type CreateKeyBody = ApiBody<operations["keys_create"]>;

/** Named by the widest response: the create answer has no timestamps. */
export type AgentConfiguration = ApiResponse<operations["configurations_get"]>;
/** The `agent` block of a Settings message, once it is not the JSON string it can arrive as. */
export type AgentBlock = Exclude<AgentConfiguration["config"], string>;
export type AgentVariable = ApiResponse<operations["variables_get"]>;
export type PurchaseOrder = ApiListItem<operations["purchases_list"], "orders">;
export type DistributionCredentialEntry = ApiListItem<
  operations["distributionCredentials_list"],
  "distribution_credentials"
>;
export type ProjectRequest = ApiListItem<operations["requests_list"], "requests">;
