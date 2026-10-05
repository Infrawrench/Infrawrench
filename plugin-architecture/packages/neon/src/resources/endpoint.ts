import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Compute sizes Neon accepts (neon.com/docs/manage/computes, October 2026;
 * 1 CU = 1 vCPU / 4 GB RAM). Autoscaling spans 0.25 to 16 CU with at most
 * 8 CU between min and max; sizes above 16 CU are fixed (min equals max).
 */
export const COMPUTE_UNITS = [
  "0.25",
  "0.5",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "18",
  "20",
  "22",
  "24",
  "26",
  "28",
  "30",
  "32",
  "34",
  "36",
  "38",
  "40",
  "42",
  "44",
  "46",
  "48",
  "50",
  "52",
  "54",
  "56",
];

export const NeonEndpointResourceType = rt({
  name: "Endpoint",
  pinnable: false,
  id: "neon-endpoint",
  description: "A Neon compute endpoint: the serverless Postgres connection point",
  fields: [
    f("host", "Host", { editable: false }),
    f("name", "Name", { required: false }),
    f("projectId", "Project ID", { editable: false }),
    f("branchId", "Branch ID", { editable: false }),
    f("currentState", "State", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("regionId", "Region", { required: false, editable: false }),
    f("lastActive", "Last Active", { required: false, editable: false }),
    // The Edit form writes these through `PATCH .../endpoints/{id}`.
    f("autoscalingMinCu", "Min Compute (CU)", {
      kind: "enum",
      enumValues: COMPUTE_UNITS,
      required: false,
    }),
    f("autoscalingMaxCu", "Max Compute (CU)", {
      kind: "enum",
      enumValues: COMPUTE_UNITS,
      required: false,
    }),
    f("suspendTimeout", "Suspend Timeout (s)", {
      kind: "number",
      required: false,
      description:
        "Seconds of inactivity before the compute suspends. 0 uses the plan default; -1 never suspends.",
    }),
  ],
  outputs: [o("host", "Host"), o("endpointId", "Endpoint ID")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "branchId", targetTypeId: "neon-branch", label: "on branch" },
  ],
  parentTypeId: "neon-branch",
  // Sleep/wake schedules: endpoint suspend/start. A suspended compute stops
  // consuming compute units; note the next incoming connection also wakes it,
  // so a scheduled suspend holds only until something connects.
  lifecycle: {
    startActionId: "start",
    stopActionId: "suspend",
    statusFieldKey: "currentState",
    runningValues: ["active"],
    stoppedValues: ["idle"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "neon",
});
