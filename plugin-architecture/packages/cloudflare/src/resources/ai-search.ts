import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AiSearchResourceType: ResourceTypeDefinition = {
  id: "ai-search",
  displayName: "AI Search",
  pluralDisplayName: "AI Search",
  description:
    "A Cloudflare AI Search (AutoRAG) instance — a managed retrieval-augmented generation pipeline over your data source",
  fields: [
    { key: "id", label: "Name", kind: "string", required: true, editable: false },
    { key: "source", label: "Source", kind: "string", required: false },
    { key: "aiSearchModel", label: "Generation Model", kind: "string", required: false },
    { key: "embeddingModel", label: "Embedding Model", kind: "string", required: false },
    { key: "vectorizeName", label: "Vectorize Index", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "paused", label: "Paused", kind: "boolean", required: false },
    { key: "lastActivity", label: "Last Activity", kind: "string", required: false },
  ],
  outputs: [{ key: "instanceId", label: "Instance Name", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "function",
};
