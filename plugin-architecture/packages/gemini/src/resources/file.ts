import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A file uploaded to the Gemini Files API. Files are temporary — the service
 * deletes them automatically at `expirationTime`, 48 hours after upload.
 *
 * Verified: https://ai.google.dev/api/files
 * `GET /v1beta/files?pageSize=&pageToken=` → `{ files: [...], nextPageToken }`.
 * ⚠️ `pageSize` here defaults to 10 and caps at **100**, unlike `models`
 * (50 / 1000). `DELETE /v1beta/files/{id}` is supported.
 *
 * Limits: 20 GB per project, 2 GB per file.
 */
export const FileResourceType = rt({
  name: "File",
  id: "file",
  description: "A file uploaded to the Gemini Files API, auto-expiring after 48 hours",
  fields: [
    f("name", "Resource Name"),
    f("displayName", "Display Name", { required: false }),
    f("mimeType", "MIME Type", { required: false }),
    f("sizeBytes", "Size (bytes)", { required: false }),
    f("state", "State", { required: false }),
    f("source", "Source", { required: false }),
    f("createTime", "Created", { required: false }),
    f("updateTime", "Updated", { required: false }),
    f("expirationTime", "Expires", { required: false }),
    f("sha256Hash", "SHA-256", { required: false }),
    f("uri", "URI", { required: false }),
    f("downloadUri", "Download URI", { required: false }),
    f("errorMessage", "Error", { required: false }),
  ],
  outputs: [
    o("fileUri", "File URI", {
      description: "Pass as `file_data.file_uri` in a generateContent request",
    }),
    o("fileName", "Resource Name", { description: 'e.g. "files/abc123xyz"' }),
    o("mimeType", "MIME Type"),
    o("state", "State"),
  ],
  iconKey: "file",
});
