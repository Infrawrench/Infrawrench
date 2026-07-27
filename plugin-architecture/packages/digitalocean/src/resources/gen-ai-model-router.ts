import { f, rt } from "@infrawrench/plugin-base";

export const GenAiModelRouterResourceType = rt({
  name: "Inference Router",
  id: "gen-ai-model-router",
  description:
    "A DigitalOcean Inference Router — picks the right model per request based on prompt complexity, balancing cost and latency across multiple foundation models. Use when your workload has mixed prompt complexity and you want automatic routing.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("regions", "Regions", {
      required: false,
      description: "Comma-separated list of target regions",
    }),
    f("fallbackModels", "Fallback Models", {
      required: false,
      editable: false,
      description: "Comma-separated list of fallback model UUIDs",
    }),
    f("policyCount", "Policies", { kind: "number", required: false, editable: false }),
  ],
  outputs: [],
  supportsCreate: true,
  iconKey: "router",
});
