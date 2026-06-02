import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AiGatewayResourceType: ResourceTypeDefinition = {
  id: "ai-gateway",
  displayName: "AI Gateway",
  pluralDisplayName: "AI Gateways",
  description:
    "A Cloudflare AI Gateway — caching, rate limiting, logging and analytics in front of your model providers",
  fields: [
    { key: "id", label: "Gateway ID", kind: "string", required: true, editable: false },
    { key: "cacheTtl", label: "Cache TTL (seconds)", kind: "number", required: false },
    {
      key: "cacheInvalidateOnUpdate",
      label: "Invalidate Cache on Update",
      kind: "boolean",
      required: false,
    },
    { key: "collectLogs", label: "Collect Logs", kind: "boolean", required: false },
    { key: "rateLimitingLimit", label: "Rate Limit (requests)", kind: "number", required: false },
    {
      key: "rateLimitingInterval",
      label: "Rate Limit Window (seconds)",
      kind: "number",
      required: false,
    },
    {
      key: "rateLimitingTechnique",
      label: "Rate Limit Technique",
      kind: "string",
      required: false,
    },
    { key: "authentication", label: "Authenticated Gateway", kind: "boolean", required: false },
    { key: "logpush", label: "Logpush", kind: "boolean", required: false },
  ],
  outputs: [{ key: "gatewayId", label: "Gateway ID", sensitive: false }],
  dashboardPinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "function",
  secretExportTemplates: [
    {
      id: "ai-gateway",
      displayName: "AI Gateway",
      description: "AI Gateway id for routing model calls through the gateway",
      entries: [{ envKey: "AI_GATEWAY_ID", outputKey: "gatewayId" }],
    },
  ],
};
