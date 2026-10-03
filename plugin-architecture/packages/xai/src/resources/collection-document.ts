import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A file indexed into a Collection. The id is the pair
 * `{collection_id}/{file_id}`, since the same uploaded file can sit in several
 * collections. Creating one attaches an existing file (picked, not typed) to
 * a collection; deleting one removes it from the collection and leaves the
 * file itself alone.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/collections/collection
 * (POST/GET/PATCH/DELETE /v1/collections/{collection_id}/documents/{file_id},
 *  GET /v1/collections/{collection_id}/documents)
 */
export const CollectionDocumentResourceType = rt({
  name: "Collection Document",
  id: "collection-document",
  description:
    "A file indexed into an xAI collection (requires a management key), with its processing status. Attach, re-index and remove.",
  fields: [
    f("collectionId", "Collection", { editable: false }),
    f("collectionName", "Collection Name", { required: false, editable: false }),
    f("fileId", "File", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("processingStatus", "Processing Status", { required: false, editable: false }),
    f("errorMessage", "Error", { required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("contentType", "Content Type", { required: false, editable: false }),
    f("filePath", "Path", { required: false, editable: false }),
    f("metadata", "Metadata Fields", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("lastIndexedAt", "Last Indexed", { required: false, editable: false }),
  ],
  outputs: [o("fileId", "File ID"), o("collectionId", "Collection ID")],
  dependsOn: [
    { fieldKey: "collectionId", targetTypeId: "collection", label: "indexed in" },
    { fieldKey: "fileId", targetTypeId: "file", label: "indexes" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "file",
});
