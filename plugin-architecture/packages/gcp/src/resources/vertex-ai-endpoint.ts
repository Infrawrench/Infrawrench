import { f, rt } from "@infrawrench/plugin-base";

export const VertexAiEndpointResourceType = rt({
  name: "Vertex AI Endpoint",
  id: "vertex-ai-endpoint",
  description: "A Google Cloud Vertex AI model serving endpoint",
  fields: [
    f("name", "Name"),
    f("displayName", "Display Name", { required: false }),
    f("region", "Region", { required: false }),
    f("state", "State", { required: false }),
    f("deployedModelCount", "Deployed Models", { kind: "number", required: false }),
    f("trafficSplit", "Traffic Split", { required: false }),
  ],
  outputs: [],
});
