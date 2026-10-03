import { f, o, rt } from "@infrawrench/plugin-base";

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "databricks-cluster",
  description: "A Databricks all-purpose or job compute cluster",
  fields: [
    f("clusterId", "Cluster ID", { editable: false }),
    f("clusterName", "Cluster Name", { editable: false }),
    f("state", "State", {
      kind: "enum",
      editable: false,
      enumValues: [
        "PENDING",
        "RUNNING",
        "RESTARTING",
        "RESIZING",
        "TERMINATING",
        "TERMINATED",
        "ERROR",
        "UNKNOWN",
      ],
    }),
    f("sparkVersion", "Spark Version", { required: false, editable: false }),
    f("nodeTypeId", "Node Type", { required: false, editable: false }),
    f("driverNodeTypeId", "Driver Node Type", { required: false, editable: false }),
    f("numWorkers", "Workers", {
      kind: "number",
      required: false,
      description:
        "Fixed worker count. On an autoscaling cluster this shows the maximum; set Min/Max Workers instead.",
    }),
    f("minWorkers", "Min Workers", {
      kind: "number",
      required: false,
      description:
        "Autoscaling lower bound. Setting min and max switches the cluster to autoscaling.",
    }),
    f("maxWorkers", "Max Workers", {
      kind: "number",
      required: false,
      description: "Autoscaling upper bound.",
    }),
    f("autoterminationMinutes", "Auto-termination (min)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("dataSecurityMode", "Access Mode", { required: false, editable: false }),
    f("clusterSource", "Source", { required: false, editable: false }),
    f("creatorUserName", "Creator", { required: false, editable: false }),
    f("stateMessage", "State Message", { required: false, editable: false }),
  ],
  outputs: [
    o("clusterId", "Cluster ID"),
    o("sparkContextId", "Spark Context ID"),
    o("jdbcUrl", "JDBC URL"),
  ],
  dependsOn: [
    { fieldKey: "nodeTypeId", targetTypeId: "databricks-node-type", label: "workers on" },
    { fieldKey: "driverNodeTypeId", targetTypeId: "databricks-node-type", label: "driver on" },
  ],
  // Sleep/wake schedules: POST /api/2.1/clusters/start and /clusters/delete
  // (which terminates; permanent deletion is a separate call).
  lifecycle: {
    startActionId: "start",
    stopActionId: "terminate",
    statusFieldKey: "state",
    runningValues: ["RUNNING", "RESIZING", "RESTARTING", "PENDING"],
    stoppedValues: ["TERMINATED", "TERMINATING"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "compute",
});
