import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SqlWarehouseResourceType: ResourceTypeDefinition = {
  id: "databricks-sql-warehouse",
  displayName: "SQL Warehouse",
  pluralDisplayName: "SQL Warehouses",
  description: "A Databricks SQL compute endpoint for running SQL queries",
  fields: [
    { key: "warehouseId", label: "Warehouse ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["STARTING", "RUNNING", "STOPPING", "STOPPED", "DELETING", "DELETED"],
    },
    { key: "clusterSize", label: "Cluster Size", kind: "string", required: false },
    { key: "minNumClusters", label: "Min Clusters", kind: "number", required: false },
    { key: "maxNumClusters", label: "Max Clusters", kind: "number", required: false },
    { key: "autoStopMinutes", label: "Auto-stop (min)", kind: "number", required: false },
    { key: "warehouseType", label: "Type", kind: "string", required: false },
    { key: "enablePhoton", label: "Photon Enabled", kind: "boolean", required: false },
    { key: "numActiveSessions", label: "Active Sessions", kind: "number", required: false },
    { key: "numRunningQueries", label: "Running Queries", kind: "number", required: false },
    { key: "creatorName", label: "Creator", kind: "string", required: false },
  ],
  outputs: [
    { key: "warehouseId", label: "Warehouse ID", sensitive: false },
    { key: "jdbcUrl", label: "JDBC URL", sensitive: false },
    { key: "odbcUrl", label: "ODBC URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  resourceSqlDriver: {
    driver: "databricks",
    connectionStringOutputKey: "warehouseId",
  },
};
