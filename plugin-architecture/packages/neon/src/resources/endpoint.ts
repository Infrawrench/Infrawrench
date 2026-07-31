import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonEndpointResourceType = rt({
  name: "Endpoint",
  pinnable: false,
  id: "neon-endpoint",
  description: "A Neon compute endpoint — the serverless Postgres connection point",
  fields: [
    f("host", "Host"),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("currentState", "State", { required: false }),
    f("type", "Type", { required: false }),
    f("autoscalingMinCu", "Min Compute (CU)", { required: false }),
    f("autoscalingMaxCu", "Max Compute (CU)", { required: false }),
    f("suspendTimeout", "Suspend Timeout (s)", { required: false }),
  ],
  outputs: [o("host", "Host"), o("endpointId", "Endpoint ID")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "branchId", targetTypeId: "neon-branch", label: "on branch" },
  ],
  parentTypeId: "neon-branch",
  supportsCreate: true,
  iconKey: "neon",
});
