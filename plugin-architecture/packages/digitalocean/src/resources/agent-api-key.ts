import { f, o, rt } from "@infrawrench/plugin-base";

export const AgentApiKeyResourceType = rt({
  name: "Endpoint Access Key",
  pinnable: false,
  id: "agent-api-key",
  description:
    "A bearer token scoped to a single Gradient AI agent's deployment endpoint. Used by client SDKs (OpenAI-compatible) and apps that call the agent directly. The secret is shown once at creation.",
  fields: [
    f("name", "Name"),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("agentUuid", "Agent UUID", {
      required: false,
      editable: false,
      description: "UUID of the agent whose endpoint this key authenticates against.",
    }),
  ],
  outputs: [
    o("secretKey", "Secret Key", {
      sensitive: true,
      description: "Bearer token for the agent's deployment endpoint. Shown once at creation.",
    }),
  ],
  // The lister records the owning agent uuid; an agent's externalId is that
  // same uuid.
  dependsOn: [{ fieldKey: "agentUuid", targetTypeId: "gen-ai-agent", label: "key for" }],
  // A bearer token for one agent. DO returns no timestamps for these, so the
  // review inventories them and asks who owns them. The plugin's "regenerate"
  // handler is a rotation, not a revocation (and no header action declares
  // it), so no `revokeActionId`.
  principalRole: { role: "key", parentKey: "createdBy" },
  parentTypeId: "gen-ai-agent",
  showInSidebar: false,
  supportsCreate: true,
  iconKey: "key",
});
