import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const WorkersAiModelResourceType: ResourceTypeDefinition = {
  id: "workers-ai-model",
  displayName: "Workers AI Model",
  pluralDisplayName: "Workers AI Models",
  description: "A Cloudflare Workers AI text-generation model you can chat with",
  fields: [
    { key: "name", label: "Model", kind: "string", required: true },
    { key: "task", label: "Task", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [],
  // Models aren't account-scoped resources you provision — they're a fixed
  // catalog, so pinning one to a dashboard makes no sense.
  dashboardPinnable: false,
  iconKey: "function",
};
