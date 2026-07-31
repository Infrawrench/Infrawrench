import { f, o, rt } from "@infrawrench/plugin-base";

export const GenAiKnowledgeBaseResourceType = rt({
  name: "Knowledge Base",
  id: "gen-ai-knowledge-base",
  description:
    "A DigitalOcean Gradient AI Platform knowledge base — a vector index built over your documents and data sources, queryable by agents for retrieval-augmented generation.",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false, editable: false }),
    f("embeddingModelUuid", "Embedding Model", {
      required: false,
      editable: false,
      description: "UUID of the embedding model used to index sources (set at creation, immutable)",
    }),
    f("databaseId", "Vector Store ID", {
      required: false,
      editable: false,
      description: "Backing OpenSearch / vector database UUID",
    }),
    f("projectId", "Project ID", { required: false, editable: false }),
    f("isPublic", "Public", { required: false, editable: false }),
    f("lastIndexingStatus", "Last Indexing Status", { required: false, editable: false }),
    f("dataSourceCount", "Data Sources", { kind: "number", required: false, editable: false }),
    f("tags", "Tags", { required: false }),
  ],
  outputs: [
    o("retrievalEndpoint", "Retrieval Endpoint", {
      description: "Hybrid retrieval endpoint URL (kbaas.do-ai.run/v1/{uuid}/retrieve)",
    }),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "project", label: "in project" },
    { fieldKey: "databaseId", targetTypeId: "managed-database", label: "backed by" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "knowledge-base",
  attachTargets: [
    {
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
    },
  ],
});
