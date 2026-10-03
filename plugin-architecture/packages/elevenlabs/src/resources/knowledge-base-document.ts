import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A document, URL or text snippet in the ElevenAgents knowledge base.
 * Listed from `GET /v1/convai/knowledge-base`; deleted with
 * `DELETE /v1/convai/knowledge-base/{documentation_id}`, which refuses while
 * an agent still depends on the document.
 * https://elevenlabs.io/docs/api-reference/knowledge-base/list
 * https://elevenlabs.io/docs/api-reference/knowledge-base/delete
 */
export const KnowledgeBaseDocumentResourceType = rt({
  name: "Knowledge Base Document",
  id: "knowledge-base-document",
  description: "A file, URL, text snippet or folder in the ElevenAgents knowledge base",
  fields: [
    f("name", "Name"),
    f("documentId", "Document ID", { required: false }),
    f("type", "Type", { required: false }),
    f("sizeBytes", "Size (bytes)", { kind: "number", required: false }),
    f("dependentAgents", "Dependent Agents", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [o("documentId", "Document ID")],
  iconKey: "document",
});
