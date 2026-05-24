import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AgentApiKeyResourceType: ResourceTypeDefinition = {
  id: "agent-api-key",
  displayName: "Endpoint Access Key",
  pluralDisplayName: "Endpoint Access Keys",
  description:
    "A bearer token scoped to a single Gradient AI agent's deployment endpoint. Used by client SDKs (OpenAI-compatible) and apps that call the agent directly. The secret is shown once at creation.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "createdBy", label: "Created By", kind: "string", required: false, editable: false },
  ],
  outputs: [
    {
      key: "secretKey",
      label: "Secret Key",
      sensitive: true,
      description: "Bearer token for the agent's deployment endpoint. Shown once at creation.",
    },
  ],
  parentTypeId: "gen-ai-agent",
  showInSidebar: false,
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "key",
};
