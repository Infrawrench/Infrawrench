import { f, o, rt } from "@infrawrench/plugin-base";

export const VectorizeIndexResourceType = rt({
  name: "Vectorize Index",
  plural: "Vectorize Indexes",
  pinnable: false,
  id: "vectorize-index",
  description: "A Cloudflare Vectorize vector database index",
  fields: [
    f("name", "Name", { editable: false }),
    f("dimensions", "Dimensions", { kind: "number", required: false, editable: false }),
    f("metric", "Distance Metric", { required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
  ],
  outputs: [o("indexName", "Index Name")],
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
});
