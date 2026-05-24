import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GenAiModelRouterResourceType: ResourceTypeDefinition = {
  id: "gen-ai-model-router",
  displayName: "Inference Router",
  pluralDisplayName: "Inference Routers",
  description:
    "A DigitalOcean Inference Router — picks the right model per request based on prompt complexity, balancing cost and latency across multiple foundation models. Use when your workload has mixed prompt complexity and you want automatic routing.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    {
      key: "regions",
      label: "Regions",
      kind: "string",
      required: false,
      description: "Comma-separated list of target regions",
    },
    {
      key: "fallbackModels",
      label: "Fallback Models",
      kind: "string",
      required: false,
      editable: false,
      description: "Comma-separated list of fallback model UUIDs",
    },
    {
      key: "policyCount",
      label: "Policies",
      kind: "number",
      required: false,
      editable: false,
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "router",
};
