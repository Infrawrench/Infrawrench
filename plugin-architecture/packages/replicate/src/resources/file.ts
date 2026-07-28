import { f, o, rt } from "@infrawrench/plugin-base";

export const FileResourceType = rt({
  name: "File",
  id: "file",
  description: "A file uploaded to Replicate for use as prediction input",
  fields: [
    f("fileId", "File ID"),
    f("name", "Name", { required: false }),
    f("contentType", "Content Type", { required: false }),
    f("size", "Size (bytes)", { kind: "number", required: false }),
    f("sha256", "SHA-256", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("expiresAt", "Expires", { required: false }),
  ],
  outputs: [
    o("fileId", "File ID"),
    o("fileUrl", "File URL", {
      description:
        "Signed download URL. Uploaded input files expire at the object's own `expires_at` — read it rather than assuming a fixed window.",
    }),
  ],
  iconKey: "storage",
});
