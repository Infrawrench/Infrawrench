import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * One document indexed inside a File Search store.
 *
 * Verified: https://ai.google.dev/api/file-search
 * `GET /v1beta/fileSearchStores/{store}/documents?pageSize=&pageToken=` →
 * `{ documents: [...], nextPageToken }`, `pageSize` default 10 / max 20.
 *
 * ⚠️ Documents use a **different state-enum prefix** from Files:
 * `STATE_PENDING` / `STATE_ACTIVE` / `STATE_FAILED`, where a File is plain
 * `PROCESSING` / `ACTIVE` / `FAILED`.
 *
 * `DELETE .../documents/{id}` also takes `?force=true`, to drop the chunks
 * derived from the document alongside it.
 */
export const FileSearchDocumentResourceType = rt({
  name: "File Search Document",
  id: "file-search-document",
  plural: "File Search Documents",
  description: "A single document indexed inside a File Search store",
  parentTypeId: "file-search-store",
  fields: [
    f("name", "Resource Name"),
    f("displayName", "Display Name", { required: false }),
    f("storeName", "Store", { required: false }),
    f("mimeType", "MIME Type", { required: false }),
    f("state", "State", { required: false }),
    f("sizeBytes", "Size (bytes)", { required: false }),
    f("createTime", "Created", { required: false }),
    f("updateTime", "Updated", { required: false }),
    f("customMetadata", "Custom Metadata", { required: false }),
  ],
  outputs: [
    o("documentName", "Document Name", {
      description: 'e.g. "fileSearchStores/my-store/documents/doc-abc123"',
    }),
    o("state", "State"),
  ],
  iconKey: "file",
});
