import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Collection: xAI's managed vector index for RAG, searched by the
 * `collections_search` tool. Lives on the management host and needs the
 * optional management key; without it this list is empty.
 *
 * Name and description are editable in place (`PUT`); the embedding model and
 * chunking are fixed at creation because changing them would mean
 * re-embedding every document.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/collections/collection
 * (POST/GET /v1/collections, GET/PUT/DELETE /v1/collections/{collection_id})
 */
export const CollectionResourceType = rt({
  name: "Collection",
  id: "collection",
  description:
    "A managed vector collection for retrieval (requires a management key). Create, rename, describe and delete.",
  fields: [
    f("collectionId", "Collection ID", { editable: false }),
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("embeddingModel", "Embedding Model", { required: false, editable: false }),
    f("chunking", "Chunking", { required: false, editable: false }),
    f("collectionType", "Type", { required: false, editable: false }),
    f("documentsCount", "Documents", { kind: "number", required: false, editable: false }),
    f("fieldDefinitions", "Metadata Fields", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("collectionId", "Collection ID", {
      description: "Pass in `collection_ids` on the collections_search tool.",
    }),
    o("name", "Collection Name"),
  ],
  // `index_configuration.model_name` is an embedding model id from
  // /v1/embedding-models, which the Model type lists.
  dependsOn: [{ fieldKey: "embeddingModel", targetTypeId: "model", label: "embeds with" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "database",
});
