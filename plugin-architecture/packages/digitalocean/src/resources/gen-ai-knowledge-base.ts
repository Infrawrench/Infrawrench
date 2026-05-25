import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GenAiKnowledgeBaseResourceType: ResourceTypeDefinition = {
  id: "gen-ai-knowledge-base",
  displayName: "Knowledge Base",
  pluralDisplayName: "Knowledge Bases",
  description:
    "A DigitalOcean Gradient AI Platform knowledge base — a vector index built over your documents and data sources, queryable by agents for retrieval-augmented generation.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false, editable: false },
    {
      key: "embeddingModelUuid",
      label: "Embedding Model",
      kind: "string",
      required: false,
      editable: false,
      description: "UUID of the embedding model used to index sources (set at creation, immutable)",
    },
    {
      key: "databaseId",
      label: "Vector Store ID",
      kind: "string",
      required: false,
      editable: false,
      description: "Backing OpenSearch / vector database UUID",
    },
    { key: "projectId", label: "Project ID", kind: "string", required: false, editable: false },
    {
      key: "isPublic",
      label: "Public",
      kind: "string",
      required: false,
      editable: false,
    },
    {
      key: "lastIndexingStatus",
      label: "Last Indexing Status",
      kind: "string",
      required: false,
      editable: false,
    },
    {
      key: "dataSourceCount",
      label: "Data Sources",
      kind: "number",
      required: false,
      editable: false,
    },
    { key: "tags", label: "Tags", kind: "string", required: false },
  ],
  outputs: [
    {
      key: "retrievalEndpoint",
      label: "Retrieval Endpoint",
      sensitive: false,
      description: "Hybrid retrieval endpoint URL (kbaas.do-ai.run/v1/{uuid}/retrieve)",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  // Editable via PUT /v2/gen-ai/knowledge_bases/{uuid}. DO's update payload
  // only accepts name/tags/project_id/database_id — region + embedding model
  // are locked above because changing them forces a full recreate.
  supportsUpdate: true,
  iconKey: "knowledge-base",
  // Drag a knowledge base onto an agent to attach it. DO's attachment
  // endpoint is POST /v2/gen-ai/agents/{agent_uuid}/knowledge_bases/{kb_uuid}
  // — no region/project match required, so no `matchField` constraint.
  attachTargets: [
    {
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
    },
  ],
};
