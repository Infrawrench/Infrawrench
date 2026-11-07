import { createApiClient, type ApiClient, type HttpHostServices } from "@infrawrench/plugin-base";
import type { components as AgentComponents, paths as AgentPaths } from "./api-types.agents.gen.js";
import type { components as LlmComponents, paths as LlmPaths } from "./api-types.llm.gen.js";
import type {
  components as TranscriptComponents,
  paths as TranscriptPaths,
} from "./api-types.transcripts.gen.js";
import type {
  components as WebhookComponents,
  paths as WebhookPaths,
} from "./api-types.webhooks.gen.js";

/**
 * AssemblyAI publishes one document per API, on three hosts:
 *
 * - `https://www.assemblyai.com/docs/openapi.json`: transcripts and uploads, per region.
 * - `.../docs/api-reference/specs/agents.yaml` and `webhooks.yaml`: voice agents, their
 *   sessions and webhooks, on one host whatever the region.
 * - `.../docs/api-reference/specs/llm-gateway.yaml`: the LLM Gateway catalogue, per region.
 *
 * All of them take the same bare key: `authorization: <key>`, no `Bearer`.
 */

/** Hosts. https://www.assemblyai.com/docs/faq/do-you-offer-servers-in-the-eu */
export const HOSTS: Record<string, string> = {
  us: "https://api.assemblyai.com",
  eu: "https://api.eu.assemblyai.com",
};

const AGENTS_BASE_URL = "https://agents.assemblyai.com/v1";
const LLM_GATEWAY_HOSTS: Record<string, string> = {
  us: "https://llm-gateway.assemblyai.com/v1",
  eu: "https://llm-gateway.eu.assemblyai.com/v1",
};

export type TranscriptSchemas = TranscriptComponents["schemas"];
export type Transcript = TranscriptSchemas["Transcript"];
export type TranscriptListItem = TranscriptSchemas["TranscriptListItem"];

export type AgentSchemas = AgentComponents["schemas"];
export type Agent = AgentSchemas["Agent"];
export type AgentListItem = AgentSchemas["AgentListItem"];
export type AudioFormat = AgentSchemas["AudioFormat"];
export type Session = AgentSchemas["SessionResponse"];
export type SessionArtifact = AgentSchemas["SessionArtifact"];

export type WebhookSubscription = WebhookComponents["schemas"]["WebhookSubscription"];
export type WebhookEvent = WebhookComponents["schemas"]["WebhookEvent"];

export type LlmModel = LlmComponents["schemas"]["ModelDetails"];
export type ModelPricing = LlmComponents["schemas"]["ModelPricing"];
export type ModelPricingData = LlmComponents["schemas"]["ModelPricingData"];

export interface AssemblyAIApis {
  transcripts: ApiClient<TranscriptPaths>;
  agents: ApiClient<AgentPaths>;
  webhooks: ApiClient<WebhookPaths>;
  llm: ApiClient<LlmPaths>;
}

export function createAssemblyAIApis(options: {
  apiKey: string;
  region: string;
  caCert: string;
  http: HttpHostServices | undefined;
}): AssemblyAIApis {
  const { apiKey, region, caCert, http } = options;
  const shared = {
    vendor: "AssemblyAI",
    headers: { authorization: apiKey, Accept: "application/json" },
    http,
    caCert,
  };
  return {
    transcripts: createApiClient<TranscriptPaths>({
      ...shared,
      baseUrl: HOSTS[region] ?? HOSTS["us"]!,
    }),
    agents: createApiClient<AgentPaths>({ ...shared, baseUrl: AGENTS_BASE_URL }),
    webhooks: createApiClient<WebhookPaths>({ ...shared, baseUrl: AGENTS_BASE_URL }),
    llm: createApiClient<LlmPaths>({
      ...shared,
      baseUrl: LLM_GATEWAY_HOSTS[region] ?? LLM_GATEWAY_HOSTS["us"]!,
    }),
  };
}
