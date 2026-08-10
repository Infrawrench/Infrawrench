import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One provider's serving endpoint for a model — the piece of data that is
 * genuinely unique to OpenRouter. Carries per-provider pricing, uptime over
 * three windows, latency percentiles and throughput.
 *
 * Docs: https://openrouter.ai/openapi.json
 * (GET /models/{author}/{slug}/endpoints → `data.endpoints[]`)
 *
 * Fanning this out across the whole catalogue would be one request per model,
 * so the top-level list is capped (see `OpenRouterClient.listModelEndpoints`).
 * Every endpoint of the model you are actually looking at is always listed on
 * that model's detail page.
 */
export const ModelEndpointResourceType = rt({
  name: "Model Endpoint",
  id: "model-endpoint",
  parentTypeId: "model",
  description:
    "A single provider's endpoint for a model — its own pricing, uptime, latency percentiles and throughput",
  fields: [
    f("endpointName", "Endpoint"),
    f("modelId", "Model ID"),
    f("providerName", "Provider", { required: false }),
    f("tag", "Tag", { required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("maxPromptTokens", "Max Prompt Tokens", { kind: "number", required: false }),
    f("maxCompletionTokens", "Max Completion Tokens", { kind: "number", required: false }),
    f("quantization", "Quantization", { required: false }),
    f("status", "Status", { required: false }),
    f("promptPricePerMillion", "Prompt Price (per 1M)", { kind: "number", required: false }),
    f("completionPricePerMillion", "Completion Price (per 1M)", {
      kind: "number",
      required: false,
    }),
    f("uptimeLast5m", "Uptime (5m)", { kind: "number", required: false }),
    f("uptimeLast30m", "Uptime (30m)", { kind: "number", required: false }),
    f("uptimeLast1d", "Uptime (1d)", { kind: "number", required: false }),
    f("latencyP50", "Latency p50 (ms)", { kind: "number", required: false }),
    f("latencyP75", "Latency p75 (ms)", { kind: "number", required: false }),
    f("latencyP90", "Latency p90 (ms)", { kind: "number", required: false }),
    f("latencyP99", "Latency p99 (ms)", { kind: "number", required: false }),
    f("throughputP50", "Throughput p50 (tok/s)", { kind: "number", required: false }),
    f("throughputP90", "Throughput p90 (tok/s)", { kind: "number", required: false }),
    f("supportsImplicitCaching", "Implicit Caching", { kind: "boolean", required: false }),
    f("supportedParameters", "Supported Parameters", { required: false }),
  ],
  outputs: [o("modelId", "Model ID"), o("providerName", "Provider")],
  // `provider_name` is the provider's display name ("OpenAI", "DeepInfra"),
  // not its slug, so it matches the Provider row's `name`. The model this
  // endpoint serves is already the parent link.
  dependsOn: [
    { fieldKey: "providerName", targetTypeId: "provider", targetKey: "name", label: "served by" },
  ],
  supportsDelete: false,
  iconKey: "server",
});
