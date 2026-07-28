import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A File Search store — Gemini's managed RAG index. Documents are uploaded,
 * chunked and embedded by the service; queries go through the `file_search`
 * tool on a generateContent request.
 *
 * Verified: https://ai.google.dev/api/file-search
 * `GET /v1beta/fileSearchStores?pageSize=&pageToken=` →
 * `{ fileSearchStores: [...], nextPageToken }`. ⚠️ `pageSize` defaults to 10
 * and caps at **20** here.
 *
 * `DELETE /v1beta/fileSearchStores/{id}` requires `?force=true` to remove a
 * store that still holds documents, otherwise it returns FAILED_PRECONDITION.
 *
 * This supersedes the older `corpora` / semantic-retrieval surface, which is
 * still listed as a v1beta resource but has no documented methods — so this
 * plugin deliberately does not model `corpora`.
 */
export const FileSearchStoreResourceType = rt({
  name: "File Search Store",
  id: "file-search-store",
  plural: "File Search Stores",
  description: "A managed RAG index of uploaded documents, queried with the file_search tool",
  fields: [
    f("name", "Resource Name"),
    f("displayName", "Display Name", { required: false }),
    f("embeddingModel", "Embedding Model", { required: false }),
    f("createTime", "Created", { required: false }),
    f("updateTime", "Updated", { required: false }),
    f("activeDocumentsCount", "Active Documents", { kind: "number", required: false }),
    f("pendingDocumentsCount", "Pending Documents", { kind: "number", required: false }),
    f("failedDocumentsCount", "Failed Documents", { kind: "number", required: false }),
    f("sizeBytes", "Size (bytes)", { required: false }),
  ],
  outputs: [
    o("fileSearchStoreName", "Store Name", {
      description: 'Pass to the file_search tool, e.g. "fileSearchStores/my-store-abc123"',
    }),
    o("activeDocumentsCount", "Active Documents"),
  ],
  supportsCreate: true,
  iconKey: "search",
});
