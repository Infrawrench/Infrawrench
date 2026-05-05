import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BigtableInstanceResourceType: ResourceTypeDefinition = {
  id: "bigtable-instance",
  displayName: "Bigtable Instance",
  pluralDisplayName: "Bigtable Instances",
  description: "A Google Cloud Bigtable instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "displayName", label: "Display Name", kind: "string", required: false },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: false,
      enumValues: ["PRODUCTION", "DEVELOPMENT", "TYPE_UNSPECIFIED"],
    },
    { key: "state", label: "State", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
};
