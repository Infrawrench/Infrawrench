import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ClusterResourceType: ResourceTypeDefinition = {
  id: "databricks-cluster",
  displayName: "Cluster",
  pluralDisplayName: "Clusters",
  description: "A Databricks all-purpose or job compute cluster",
  fields: [
    { key: "clusterId", label: "Cluster ID", kind: "string", required: true },
    { key: "clusterName", label: "Cluster Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
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
    },
    { key: "sparkVersion", label: "Spark Version", kind: "string", required: false },
    { key: "nodeTypeId", label: "Node Type", kind: "string", required: false },
    { key: "driverNodeTypeId", label: "Driver Node Type", kind: "string", required: false },
    { key: "numWorkers", label: "Workers", kind: "number", required: false },
    {
      key: "autoterminationMinutes",
      label: "Auto-termination (min)",
      kind: "number",
      required: false,
    },
    { key: "clusterSource", label: "Source", kind: "string", required: false },
    { key: "creatorUserName", label: "Creator", kind: "string", required: false },
  ],
  outputs: [
    { key: "clusterId", label: "Cluster ID", sensitive: false },
    { key: "sparkContextId", label: "Spark Context ID", sensitive: false },
    { key: "jdbcUrl", label: "JDBC URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "compute",
};
