import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NeonEndpointResourceType: ResourceTypeDefinition = {
  id: "neon-endpoint",
  displayName: "Endpoint",
  pluralDisplayName: "Endpoints",
  description: "A Neon compute endpoint — the serverless Postgres connection point",
  fields: [
    { key: "host", label: "Host", kind: "string", required: true },
    { key: "projectId", label: "Project ID", kind: "string", required: true },
    { key: "branchId", label: "Branch ID", kind: "string", required: true },
    { key: "currentState", label: "State", kind: "string", required: false },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "autoscalingMinCu", label: "Min Compute (CU)", kind: "string", required: false },
    { key: "autoscalingMaxCu", label: "Max Compute (CU)", kind: "string", required: false },
    { key: "suspendTimeout", label: "Suspend Timeout (s)", kind: "string", required: false },
  ],
  outputs: [
    { key: "host", label: "Host", sensitive: false },
    { key: "endpointId", label: "Endpoint ID", sensitive: false },
  ],
  parentTypeId: "neon-branch",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "neon",
};
