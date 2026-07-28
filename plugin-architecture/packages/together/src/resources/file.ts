import { f, o, rt } from "@infrawrench/plugin-base";

export const FileResourceType = rt({
  name: "File",
  id: "file",
  description: "A dataset uploaded to Together AI for fine-tuning, evaluation or batch inference",
  fields: [
    f("filename", "Filename"),
    f("fileId", "File ID"),
    f("purpose", "Purpose", { required: false }),
    f("fileType", "Format", { required: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false }),
    f("lineCount", "Lines", { kind: "number", required: false }),
    f("processingStatus", "Processing Status", { required: false }),
    f("validationError", "Validation Error", { required: false }),
    f("createdAt", "Uploaded", { required: false }),
  ],
  outputs: [o("fileId", "File ID"), o("filename", "Filename")],
  iconKey: "storage",
});
