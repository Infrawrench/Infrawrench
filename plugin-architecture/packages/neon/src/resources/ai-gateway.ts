import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The AI Gateway control-plane surface is a single read-only GET returning
 * `{ enabled, base_url }`. Model routing, logging, and cost controls have no
 * management API, so this type is deliberately read-only: it surfaces the base
 * URL to point an OpenAI-compatible SDK at. Enablement lives in `neon.ts`.
 */
export const NeonAiGatewayResourceType = rt({
  name: "AI Gateway",
  plural: "AI Gateways",
  id: "neon-ai-gateway",
  description: "A Neon AI Gateway endpoint — one OpenAI-compatible API for frontier models",
  fields: [f("baseUrl", "Base URL"), f("projectId", "Project ID"), f("branchId", "Branch ID")],
  outputs: [o("baseUrl", "Base URL")],
  parentTypeId: "neon-branch",
  iconKey: "network",
  secretExportTemplates: [
    {
      id: "openai-compatible",
      displayName: "OpenAI-Compatible Base URL",
      description:
        "Point an OpenAI-compatible SDK at the gateway. Pair with a credential scoped to ai_gateway:invoke for the API key.",
      entries: [{ envKey: "OPENAI_BASE_URL", outputKey: "baseUrl" }],
    },
  ],
});
