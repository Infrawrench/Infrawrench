import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A file uploaded to the workspace — fine-tuning datasets, batch request
 * JSONL, and OCR inputs all live here.
 *
 * `GET https://api.mistral.ai/v1/files`
 * https://docs.mistral.ai/api/endpoint/files
 */
export const MistralFileResourceType = rt({
  name: "File",
  id: "mistral-file",
  description: "A file uploaded to Mistral for fine-tuning, batch inference, or OCR",
  fields: [
    f("fileId", "File ID"),
    f("filename", "Filename", { required: false }),
    f("purpose", "Purpose", { required: false }),
    f("sampleType", "Sample Type", { required: false }),
    f("source", "Source", { required: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false }),
    f("numLines", "Lines", { kind: "number", required: false }),
    f("mimetype", "MIME Type", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("fileId", "File ID"), o("filename", "Filename")],
  supportsDelete: true,
  iconKey: "file",
});
