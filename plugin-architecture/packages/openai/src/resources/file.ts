import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET /v1/files`, `DELETE /v1/files/{file_id}` — verified 2026-07-29 against
 * openapi.yaml v2.3.0 (`listFiles`, `deleteFile`).
 *
 * Upload is intentionally not wired: `POST /v1/files` is multipart with a real
 * file body, which the create-form contract has no field kind for.
 */
export const FileResourceType = rt({
  name: "File",
  id: "file",
  description:
    "An uploaded file — fine-tuning datasets, batch inputs and outputs, and file-search source documents.",
  fields: [
    f("filename", "Filename"),
    f("purpose", "Purpose", { required: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("expiresAt", "Expires", { required: false }),
  ],
  outputs: [o("fileId", "File ID"), o("filename", "Filename")],
  iconKey: "file",
  supportsDelete: true,
});
