import { f, o, rt } from "@infrawrench/plugin-base";

export const AgentApiKeyResourceType = rt({
  name: "Endpoint Access Key",
  pinnable: false,
  id: "agent-api-key",
  description:
    "A bearer token scoped to a single Gradient AI agent's deployment endpoint. Used by client SDKs (OpenAI-compatible) and apps that call the agent directly. The secret is shown once at creation.",
  fields: [f("name", "Name"), f("createdBy", "Created By", { required: false, editable: false })],
  outputs: [
    o("secretKey", "Secret Key", {
      sensitive: true,
      description: "Bearer token for the agent's deployment endpoint. Shown once at creation.",
    }),
  ],
  parentTypeId: "gen-ai-agent",
  showInSidebar: false,
  supportsCreate: true,
  iconKey: "key",
});
