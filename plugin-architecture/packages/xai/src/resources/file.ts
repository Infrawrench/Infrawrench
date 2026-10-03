import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A file uploaded to xAI's storage and referenceable by id anywhere a
 * `file_id` is accepted.
 *
 * A file can be given a permanent unauthenticated CDN URL and have it revoked
 * again, which are the two plugin actions on this type.
 *
 * Docs: https://docs.x.ai/openapi.json  (GET/POST /v1/files, DELETE /v1/files/{file_id},
 * POST /v1/files/{file_id}/public-url, POST /v1/files/{file_id}/public-url/revoke)
 */
export const FileResourceType = rt({
  name: "File",
  id: "file",
  description: "A file uploaded to xAI storage and referenceable by ID in chat attachments",
  fields: [
    f("fileId", "File ID"),
    f("filename", "Filename"),
    f("bytes", "Size (bytes)", { kind: "number", required: false }),
    f("purpose", "Purpose", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("expiresAt", "Expires", { required: false }),
    f("publicUrl", "Public URL", { required: false }),
    f("publicUrlExpiresAt", "Public URL Expires", { required: false }),
  ],
  outputs: [o("fileId", "File ID"), o("filename", "Filename"), o("publicUrl", "Public URL")],
  iconKey: "file",
});
