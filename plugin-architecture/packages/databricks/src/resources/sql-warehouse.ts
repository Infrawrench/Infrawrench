import { f, o, rt } from "@infrawrench/plugin-base";

export const SqlWarehouseResourceType = rt({
  name: "SQL Warehouse",
  id: "databricks-sql-warehouse",
  description: "A Databricks SQL compute endpoint for running SQL queries",
  fields: [
    f("warehouseId", "Warehouse ID"),
    f("name", "Name"),
    f("state", "State", {
      kind: "enum",
      enumValues: ["STARTING", "RUNNING", "STOPPING", "STOPPED", "DELETING", "DELETED"],
    }),
    f("clusterSize", "Cluster Size", { required: false }),
    f("minNumClusters", "Min Clusters", { kind: "number", required: false }),
    f("maxNumClusters", "Max Clusters", { kind: "number", required: false }),
    f("autoStopMinutes", "Auto-stop (min)", { kind: "number", required: false }),
    f("warehouseType", "Type", { required: false }),
    f("enablePhoton", "Photon Enabled", { kind: "boolean", required: false }),
    f("numActiveSessions", "Active Sessions", { kind: "number", required: false }),
    f("numRunningQueries", "Running Queries", { kind: "number", required: false }),
    f("creatorName", "Creator", { required: false }),
  ],
  outputs: [
    o("warehouseId", "Warehouse ID"),
    o("jdbcUrl", "JDBC URL"),
    o("odbcUrl", "ODBC URL"),
    o("httpPath", "HTTP Path", { description: "HTTP path for the SQL Connector / JDBC driver" }),
    o("serverHostname", "Server Hostname", {
      description: "Workspace hostname for the SQL Connector",
    }),
  ],
  supportsCreate: true,
  iconKey: "database",
  resourceSqlDriver: {
    driver: "databricks",
    connectionStringOutputKey: "warehouseId",
  },
  secretExportTemplates: [
    {
      id: "databricks-sql",
      displayName: "Databricks SQL Connector",
      description:
        "Environment variables for databricks-sql-connector / JDBC. Pair with a Databricks PAT.",
      entries: [
        { envKey: "DATABRICKS_HOST", outputKey: "serverHostname" },
        { envKey: "DATABRICKS_HTTP_PATH", outputKey: "httpPath" },
        { envKey: "DATABRICKS_WAREHOUSE_ID", outputKey: "warehouseId" },
      ],
    },
  ],
});
