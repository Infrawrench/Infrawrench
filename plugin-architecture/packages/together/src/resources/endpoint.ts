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
  // `model` is a `/models` id and `hardware` a `/hardware` id — the same two
  // catalogues the create form's pickers are built from.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "model", label: "serves" },
    { fieldKey: "hardware", targetTypeId: "hardware", label: "runs on" },
  ],
  // Sleep/wake schedules: the existing start/stop header actions (both PATCH
  // the endpoint state). A stopped dedicated endpoint releases its reserved
  // GPU hardware, so the off-hours saving here is real.
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["STARTED", "STARTING", "PENDING"],
    stoppedValues: ["STOPPED", "STOPPING"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "deployment",
});
