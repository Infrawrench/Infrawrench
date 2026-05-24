import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BedrockModelResourceType: ResourceTypeDefinition = {
  id: "bedrock-model",
  displayName: "Bedrock Model",
  pluralDisplayName: "Bedrock Models",
  description: "An Amazon Bedrock foundation model you can chat with via the Converse API",
  fields: [
    { key: "modelId", label: "Model ID", kind: "string", required: true },
    { key: "modelName", label: "Model Name", kind: "string", required: false },
    { key: "providerName", label: "Provider", kind: "string", required: false },
    { key: "streamingSupported", label: "Streaming Supported", kind: "boolean", required: false },
  ],
  outputs: [],
  // Foundation models are catalog entries, not lifecycle resources — there's
  // no per-model metric to chart on a dashboard tile.
  dashboardPinnable: false,
  iconKey: "function",
  supportsMetrics: false,
};
