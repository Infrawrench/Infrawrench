import { f, rt } from "@infrawrench/plugin-base";

export const GenAiModelRouterResourceType = rt({
  name: "Inference Router",
  id: "gen-ai-model-router",
  description:
    "A DigitalOcean Inference Router: picks a model per request by prompt complexity, balancing cost and latency.",
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
