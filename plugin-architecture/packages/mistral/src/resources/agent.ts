import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An agent: a model plus instructions, tools and completion arguments,
 * addressable by id from the Conversations API.
 *
 * `GET /v1/agents/pages` (cursor-paged; the page-numbered `GET /v1/agents` is
 * deprecated and ignores per-agent sharing). Create is `POST /v1/agents`,
 * edit is `PATCH /v1/agents/{agent_id}` (each edit mints a new version),
 * delete is `DELETE /v1/agents/{agent_id}`.
 * https://docs.mistral.ai/openapi.yaml
 */
export const MistralAgentResourceType = rt({
  name: "Agent",
  id: "mistral-agent",
  description:
    "A Mistral agent: a model with its own instructions, tools and completion arguments. Create, edit (each edit is a new version) and delete.",
  fields: [
    f("agentId", "Agent ID", { editable: false }),
    f("name", "Name"),
    f("model", "Model", { editable: false }),
    f("description", "Description", { required: false }),
    f("instructions", "Instructions", { required: false }),
    f("tools", "Tools", { required: false, editable: false }),
    f("libraries", "Libraries", { required: false, editable: false }),
    f("handoffs", "Handoffs", { required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("versionCount", "Versions", { kind: "number", required: false, editable: false }),
    f("versionMessage", "Version Note", { required: false, editable: false }),
    f("deploymentChat", "Available in Le Chat", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("source", "Source", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("agentId", "Agent ID", { description: "Pass as `agent_id` to the Conversations API" }),
    o("name", "Agent Name"),
  ],
  // `model` is a `/v1/models` id; `libraries` is the comma-joined library ids
  // of the agent's document_library tools; `handoffs` are other agent ids.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "mistral-model", label: "runs on" },
    { fieldKey: "libraries", targetTypeId: "mistral-library", label: "searches" },
    { fieldKey: "handoffs", targetTypeId: "mistral-agent", label: "hands off to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "app",
});
