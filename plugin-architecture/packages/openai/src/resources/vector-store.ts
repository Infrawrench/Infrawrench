import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/vector_stores`, `POST/DELETE /v1/vector_stores/{id}` — verified
 * 2026-07-29 against openapi.yaml v2.3.0 (`listVectorStores`,
 * `createVectorStore`, `modifyVectorStore`, `deleteVectorStore`).
 */
export const VectorStoreResourceType = rt({
  name: "Vector Store",
  id: "vector-store",
  description:
    "A collection of chunked and embedded files backing the `file_search` tool. Files are attached from the Files list.",
  fields: [
    f("name", "Name", { required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["expired", "in_progress", "completed"],
      required: false,
    }),
    f("usageBytes", "Storage Used (bytes)", { kind: "number", required: false }),
    f("filesTotal", "Files", { kind: "number", required: false }),
    f("filesCompleted", "Files Ready", { kind: "number", required: false }),
    f("filesInProgress", "Files Processing", { kind: "number", required: false }),
    f("filesFailed", "Files Failed", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("lastActiveAt", "Last Active", { required: false }),
    f("expiresAt", "Expires", { required: false }),
  ],
  outputs: [o("vectorStoreId", "Vector Store ID"), o("name", "Name")],
  iconKey: "search",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});
