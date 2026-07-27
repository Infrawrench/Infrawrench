import { f, rt } from "@infrawrench/plugin-base";

export const BedrockModelResourceType = rt({
  name: "Bedrock Model",
  pinnable: false,
  id: "bedrock-model",
  description: "An Amazon Bedrock foundation model you can chat with via the Converse API",
  fields: [
    f("modelId", "Model ID"),
    f("modelName", "Model Name", { required: false }),
    f("providerName", "Provider", { required: false }),
    f("streamingSupported", "Streaming Supported", { kind: "boolean", required: false }),
  ],
  outputs: [],
  iconKey: "function",
  supportsMetrics: false,
});
