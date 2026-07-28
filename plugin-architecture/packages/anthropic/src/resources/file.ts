import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A file uploaded through the Files API and referenced from message content
 * blocks by its `file_id`. Files are scoped to the workspace that owns the
 * API key.
 *
 * Docs: https://platform.claude.com/docs/en/api/files-list
 */
export const FileResourceType = rt({
  name: "File",
  id: "file",
  description:
    "A file uploaded through the Files API, referenced from message content blocks by its file_id. Scoped to the workspace that owns the API key.",
  fields: [
    f("filename", "Filename", { editable: false }),
    f("mimeType", "MIME Type", { required: false, editable: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("downloadable", "Downloadable", { kind: "boolean", required: false, editable: false }),
    f("scopeType", "Scope Type", { required: false, editable: false }),
    f("scopeId", "Scope ID", { required: false, editable: false }),
  ],
  outputs: [
    o("fileId", "File ID", {
      description:
        'Value to use in a content block as `{"type":"document","source":{"file_id":…}}`.',
    }),
    o("filename", "Filename"),
  ],
  supportsCreate: false,
  supportsDelete: true,
  iconKey: "storage",
});
