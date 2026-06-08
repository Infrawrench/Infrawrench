import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TursoDatabaseInstanceResourceType: ResourceTypeDefinition = {
  id: "turso-database-instance",
  displayName: "Database Instance",
  pluralDisplayName: "Database Instances",
  description: "A primary or replica instance backing a Turso database",
  fields: [
    { key: "database", label: "Database", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "uuid", label: "UUID", kind: "string", required: false },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "hostname", label: "Hostname", kind: "string", required: false },
  ],
  outputs: [
    { key: "hostname", label: "Hostname", sensitive: false },
    { key: "instanceName", label: "Instance Name", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "turso",
};
