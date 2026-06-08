import { f, o, rt } from "@infrawrench/plugin-base";

export const AiSearchResourceType = rt({
  name: "AI Search",
  plural: "AI Search",
  pinnable: false,
  id: "ai-search",
  description:
    "A Cloudflare AI Search (AutoRAG) instance — a managed retrieval-augmented generation pipeline over your data source",
  fields: [
    f("id", "Name", { editable: false }),
    f("source", "Source", { required: false }),
    f("aiSearchModel", "Generation Model", { required: false }),
    f("embeddingModel", "Embedding Model", { required: false }),
    f("vectorizeName", "Vectorize Index", { required: false }),
    f("status", "Status", { required: false }),
    f("paused", "Paused", { kind: "boolean", required: false }),
    f("lastActivity", "Last Activity", { required: false }),
  ],
  outputs: [o("instanceId", "Instance Name")],
  iconKey: "function",
});
