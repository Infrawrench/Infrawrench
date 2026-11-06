import { f, rt } from "@infrawrench/plugin-base";

export const VertexAiEndpointResourceType = rt({
  name: "Vertex AI Endpoint",
  id: "vertex-ai-endpoint",
  iconKey: "model",
  description: "A Google Cloud Vertex AI model serving endpoint",
  fields: [
    f("name", "Name"),
    f("displayName", "Display Name", { required: false }),
    f("region", "Region", { showcase: true, required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("deployedModelCount", "Deployed Models", { showcase: true, kind: "number", required: false }),
    f("trafficSplit", "Traffic Split", { required: false }),
  ],
  outputs: [],
  supportsMetrics: true,
});
