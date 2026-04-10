import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VertexAiEndpointResourceType: ResourceTypeDefinition = {
  id: "vertex-ai-endpoint",
  displayName: "Vertex AI Endpoint",
  pluralDisplayName: "Vertex AI Endpoints",
  description: "A Google Cloud Vertex AI model serving endpoint",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "displayName", label: "Display Name", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "deployedModelCount", label: "Deployed Models", kind: "number", required: false },
    { key: "trafficSplit", label: "Traffic Split", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
};
