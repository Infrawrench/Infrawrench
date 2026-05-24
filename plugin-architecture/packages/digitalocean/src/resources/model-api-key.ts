import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ModelApiKeyResourceType: ResourceTypeDefinition = {
  id: "model-api-key",
  displayName: "Model API Key",
  pluralDisplayName: "Model API Keys",
  description:
    "A DigitalOcean model access key — scoped credential used to authenticate against the serverless inference endpoints at inference.do-ai.run. Use this from CLIs, SDKs (OpenAI-compatible), or backend services that call models directly.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "createdBy", label: "Created By", kind: "string", required: false, editable: false },
    { key: "lastUsedAt", label: "Last Used", kind: "string", required: false, editable: false },
  ],
  outputs: [
    {
      key: "secretKey",
      label: "Secret Key",
      sensitive: true,
      description: "Bearer token for the inference.do-ai.run endpoints. Shown once at creation.",
    },
  ],
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "key",
};
