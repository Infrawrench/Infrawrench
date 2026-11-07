import {
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type {
  operations as orchestratorOperations,
  paths as orchestratorPaths,
} from "./api-types.orchestrator.gen.js";
import type {
  components as platformComponents,
  operations as platformOperations,
  paths as platformPaths,
} from "./api-types.platform.gen.js";

/** https://docs.perplexity.ai/openapi.json (and openapi-gateway-chat.json), Oct 2026. */
export const API_BASE = "https://api.perplexity.ai";

/**
 * The document now calls this API the Orchestrator, at `/orchestrator/v1`. Its
 * quickstart says "the old `/router/v1` base URL keeps working", and that is what
 * the plugin has always called, so the generated paths drop the prefix and this
 * supplies it.
 */
const ROUTER_PREFIX = "/router/v1";

export type PlatformApi = ApiClient<platformPaths>;
export type RouterApi = ApiClient<orchestratorPaths>;

/** A platform operation's response, by its `operationId`. */
type PlatformResponse<Op extends keyof platformOperations> = ApiResponse<platformOperations[Op]>;

type RouterModel = ApiResponse<orchestratorOperations["gateway_retrieve_model"]>;
/** Either catalogue's model: only the Router's carries `pricing`. */
export type ListedModel = Omit<RouterModel, "pricing"> & { pricing?: RouterModel["pricing"] };
/** The widest of the two: a list row is a summary with no `response` or `error_message`. */
export type AsyncRequest =
  PlatformResponse<"get_async_chat_completion_response_async_chat_completions__api_request__get">;
/** A completion's message content: text, typed chunks, or nothing. */
export type MessageContent = platformComponents["schemas"]["ChatMessage-Output"]["content"];
/** The widest of the two: a list row has no `description`. */
export type Skill = PlatformResponse<"getSkill">;

function createOptions(
  credentials: { apiKey: string; caCert: string; http: HttpHostServices | undefined },
  prefix: string,
): ApiClientOptions {
  return {
    vendor: "Perplexity",
    baseUrl: `${API_BASE}${prefix}`,
    headers: { Authorization: `Bearer ${credentials.apiKey}`, Accept: "application/json" },
    http: credentials.http,
    caCert: credentials.caCert,
    encodeQuery: encodeURIComponent,
    // No query in the message. An unencoded Router id can hold a `?` of its own.
    httpError: ({ status, path, body }) =>
      new Error(
        `Perplexity API error ${status} for ${prefix}${path.split("?")[0] ?? path}: ${body}`,
      ),
  };
}

/** The platform API, and the Router API on the same host with the same key. */
export function createPerplexityApis(credentials: {
  apiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}): { platform: PlatformApi; router: RouterApi } {
  return {
    platform: createApiClient<platformPaths>(createOptions(credentials, "")),
    router: createApiClient<orchestratorPaths>(createOptions(credentials, ROUTER_PREFIX)),
  };
}

function withStatus(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const m = /API error (\d{3})\b/.exec(err.message);
  if (!m) return err;
  const status = Number(m[1]);
  const hint =
    status === 401
      ? " Check the API key under API Keys in the Perplexity API console."
      : status === 402
        ? " The project is out of credits: top up on the Billing page."
        : "";
  return Object.assign(new Error(`${err.message}${hint}`), { status });
}

/** A call whose failure carries its HTTP status, and a hint for the two a user can act on. */
export async function statusErrors<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw withStatus(err);
  }
}
