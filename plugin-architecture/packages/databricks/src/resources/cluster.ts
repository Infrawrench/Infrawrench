import { f, o, rt } from "@infrawrench/plugin-base";

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "databricks-cluster",
  description: "A Databricks all-purpose or job compute cluster",
  fields: [
    f("clusterId", "Cluster ID"),
    f("clusterName", "Cluster Name"),
    f("state", "State", {
      kind: "enum",
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
    f("sparkVersion", "Spark Version", { required: false }),
    f("nodeTypeId", "Node Type", { required: false }),
    f("driverNodeTypeId", "Driver Node Type", { required: false }),
    f("numWorkers", "Workers", { kind: "number", required: false }),
    f("autoterminationMinutes", "Auto-termination (min)", { kind: "number", required: false }),
    f("clusterSource", "Source", { required: false }),
    f("creatorUserName", "Creator", { required: false }),
  ],
  outputs: [
    o("clusterId", "Cluster ID"),
    o("sparkContextId", "Spark Context ID"),
    o("jdbcUrl", "JDBC URL"),
  ],
  supportsCreate: true,
  iconKey: "compute",
});
