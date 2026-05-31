import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VectorizeIndexResourceType: ResourceTypeDefinition = {
  id: "vectorize-index",
  displayName: "Vectorize Index",
  pluralDisplayName: "Vectorize Indexes",
  description: "A Cloudflare Vectorize vector database index",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true, editable: false },
    { key: "dimensions", label: "Dimensions", kind: "number", required: false, editable: false },
    { key: "metric", label: "Distance Metric", kind: "string", required: false, editable: false },
    { key: "description", label: "Description", kind: "string", required: false, editable: false },
  ],
  outputs: [{ key: "indexName", label: "Index Name", sensitive: false }],
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "database",
  secretExportTemplates: [
    {
      id: "vectorize-index",
      displayName: "Vectorize Index",
      description: "Vectorize index name for Worker bindings",
      entries: [{ envKey: "VECTORIZE_INDEX", outputKey: "indexName" }],
    },
  ],
};
