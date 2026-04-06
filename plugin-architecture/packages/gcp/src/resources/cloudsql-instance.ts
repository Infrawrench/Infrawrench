import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudSqlInstanceResourceType: ResourceTypeDefinition = {
  id: "cloudsql-instance",
  displayName: "Cloud SQL Instance",
  pluralDisplayName: "Cloud SQL Instances",
  description: "A Google Cloud SQL managed database instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "databaseVersion", label: "Database Version", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "tier", label: "Machine Tier", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "availabilityType", label: "Availability Type", kind: "string", required: false },
  ],
  outputs: [
    { key: "connectionName", label: "Connection Name", sensitive: false, description: "project:region:instance" },
    { key: "ipAddress", label: "IP Address", sensitive: false },
  ],
  dashboardPinnable: true,
};
