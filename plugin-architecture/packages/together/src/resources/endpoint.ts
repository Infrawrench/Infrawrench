import { f, o, rt } from "@infrawrench/plugin-base";

export const EndpointResourceType = rt({
  name: "Dedicated Endpoint",
  id: "endpoint",
  plural: "Dedicated Endpoints",
  description:
    "A dedicated inference endpoint: a model on reserved GPU hardware with its own autoscaling",
  fields: [
    f("displayName", "Display Name"),
    f("endpointId", "Endpoint ID"),
    f("name", "Endpoint Name", { required: false }),
    f("model", "Model", { showcase: true }),
    f("hardware", "Hardware", { required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("minReplicas", "Min Replicas", { kind: "number", required: false }),
    f("maxReplicas", "Max Replicas", { kind: "number", required: false }),
    f("type", "Type", { showcase: true, required: false }),
    f("owner", "Owner", { required: false }),
    f("createdAt", "Created", { showcase: true, required: false }),
  ],
  outputs: [
    o("endpointId", "Endpoint ID"),
    o("endpointName", "Endpoint Name", {
      description: "Pass this as `model` when calling the dedicated endpoint",
    }),
    o("baseUrl", "Inference Base URL"),
  ],
  // `model` is a `/models` id and `hardware` a `/hardware` id.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "model", label: "serves" },
    { fieldKey: "hardware", targetTypeId: "hardware", label: "runs on" },
  ],
  // No create: Together refuses new v1 endpoints, and Managed Endpoint is the replacement.
  // https://docs.together.ai/docs/dedicated-endpoints/migrate-from-v1
  supportsUpdate: true,
  iconKey: "deployment",
});
