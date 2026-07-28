import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A file uploaded to GroqCloud — batch input/output JSONL, or a LoRA adapter
 * archive destined for a fine-tuning registration.
 *
 * `GET https://api.groq.com/openai/v1/files`
 */
export const GroqFileResourceType = rt({
  name: "File",
  id: "groq-file",
  description: "A file uploaded to GroqCloud for batch inference or LoRA registration",
  fields: [
    f("fileId", "File ID"),
    f("filename", "Filename", { required: false }),
    f("purpose", "Purpose", { required: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("fileId", "File ID"), o("filename", "Filename")],
  supportsDelete: true,
  iconKey: "file",
});
