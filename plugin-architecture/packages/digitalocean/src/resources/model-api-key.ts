import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ModelApiKeyResourceType: ResourceTypeDefinition = {
  id: "model-api-key",
  displayName: "Model API Key",
  pluralDisplayName: "Model API Keys",
  description:
    "A DigitalOcean model access key — scoped credential used to authenticate against the serverless inference endpoints at inference.do-ai.run. Create these in DigitalOcean's Model Studio (the create endpoint is retired); Infrawrench lists and deletes them.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "createdBy", label: "Created By", kind: "string", required: false, editable: false },
    { key: "lastUsedAt", label: "Last Used", kind: "string", required: false, editable: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  // Create is retired upstream — DO returns "resource retired: Creating model
  // API keys through this endpoint is retired. Go to Model Studio…". So we
  // only list + delete existing keys; no create panel.
  iconKey: "key",
};
