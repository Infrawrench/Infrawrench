import { f, o, rt } from "@infrawrench/plugin-base";

export const EndpointResourceType = rt({
  name: "Dedicated Endpoint",
  id: "endpoint",
  plural: "Dedicated Endpoints",
  description:
    "A dedicated inference endpoint — a model pinned to reserved GPU hardware with its own autoscaling window",
  fields: [
    f("displayName", "Display Name"),
    f("endpointId", "Endpoint ID"),
    f("name", "Endpoint Name", { required: false }),
    f("model", "Model"),
    f("hardware", "Hardware", { required: false }),
    f("state", "State", { required: false }),
    f("minReplicas", "Min Replicas", { kind: "number", required: false }),
    f("maxReplicas", "Max Replicas", { kind: "number", required: false }),
    f("type", "Type", { required: false }),
    f("owner", "Owner", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [
    o("endpointId", "Endpoint ID"),
    o("endpointName", "Endpoint Name", {
      description: "Pass this as `model` when calling the dedicated endpoint",
    }),
    o("baseUrl", "Inference Base URL"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "deployment",
});
