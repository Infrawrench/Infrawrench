import { f, o, rt } from "@infrawrench/plugin-base";

export const AiGatewayResourceType = rt({
  name: "AI Gateway",
  pinnable: false,
  id: "ai-gateway",
  description:
    "A Cloudflare AI Gateway — caching, rate limiting, logging and analytics in front of your model providers",
  fields: [
    f("id", "Gateway ID", { editable: false }),
    f("cacheTtl", "Cache TTL (seconds)", { kind: "number", required: false }),
    f("cacheInvalidateOnUpdate", "Invalidate Cache on Update", {
      kind: "boolean",
      required: false,
    }),
    f("collectLogs", "Collect Logs", { kind: "boolean", required: false }),
    f("rateLimitingLimit", "Rate Limit (requests)", { kind: "number", required: false }),
    f("rateLimitingInterval", "Rate Limit Window (seconds)", { kind: "number", required: false }),
    f("rateLimitingTechnique", "Rate Limit Technique", { required: false }),
    f("authentication", "Authenticated Gateway", { kind: "boolean", required: false }),
    f("logpush", "Logpush", { kind: "boolean", required: false }),
  ],
  outputs: [o("gatewayId", "Gateway ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "function",
  secretExportTemplates: [
    {
      id: "ai-gateway",
      displayName: "AI Gateway",
      description: "AI Gateway id for routing model calls through the gateway",
      entries: [{ envKey: "AI_GATEWAY_ID", outputKey: "gatewayId" }],
    },
  ],
});
