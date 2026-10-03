import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An image uploaded through DeepSeek's Files API, referenced by `file_id` in
 * a chat request's `file` content block so it is uploaded once and reused.
 *
 * Images only (JPEG, PNG, GIF, WebP), `purpose` is always `user_data`, and a
 * file either lives forever or carries an `expires_at` chosen at upload
 * (1 hour to 30 days). Listing pages with an `after` cursor; there is no
 * update, so the only mutation here is delete.
 *
 * Docs: https://api-docs.deepseek.com/api/list-files,
 * https://api-docs.deepseek.com/api/delete-file,
 * https://api-docs.deepseek.com/guides/files_api
 */
export const FileResourceType = rt({
  name: "File",
  id: "file",
  description:
    "An image uploaded through the DeepSeek Files API and referenced by file_id in chat requests. Upload happens from your own code; Infrawrench lists and deletes.",
  fields: [
    f("fileId", "File ID", { editable: false }),
    f("filename", "Filename", { required: false, editable: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("purpose", "Purpose", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
  ],
  outputs: [
    o("fileId", "File ID", {
      description: "Pass as `file_id` in a `file` content block on POST /chat/completions.",
    }),
    o("filename", "Filename"),
  ],
  supportsCreate: false,
  supportsDelete: true,
  iconKey: "file",
});
