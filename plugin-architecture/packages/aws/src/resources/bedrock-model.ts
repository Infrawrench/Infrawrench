import { f, o, rt } from "@infrawrench/plugin-base";

export const BedrockModelResourceType = rt({
  name: "Bedrock Model",
  pinnable: false,
  id: "bedrock-model",
  description:
    "An Amazon Bedrock foundation model or inference profile you can chat with via the Converse API",
  fields: [
    f("modelId", "Model ID", {
      description: "Foundation model id or inference profile id passed to Converse",
    }),
    f("modelName", "Model Name", { required: false }),
    f("providerName", "Provider", { required: false }),
    f("kind", "Kind", {
      kind: "enum",
      required: false,
      enumValues: ["foundation-model", "inference-profile", "application-inference-profile"],
      description:
        "Inference profiles route requests across regions; most newer models are only callable through one",
    }),
    f("lifecycleStatus", "Lifecycle", {
      kind: "enum",
      required: false,
      enumValues: ["ACTIVE", "LEGACY"],
      description: "LEGACY models are scheduled for end of life; plan a migration",
    }),
    f("sourceModels", "Routes To", {
      required: false,
      description: "Foundation models an inference profile sends requests to",
    }),
    f("streamingSupported", "Streaming Supported", { kind: "boolean", required: false }),
  ],
  outputs: [o("arn", "ARN")],
  iconKey: "function",
  supportsMetrics: true,
});
