import { f, rt } from "@infrawrench/plugin-base";

export const BigtableInstanceResourceType = rt({
  name: "Bigtable Instance",
  id: "bigtable-instance",
  iconKey: "table",
  description: "A Google Cloud Bigtable instance",
  fields: [
    f("name", "Name"),
    f("displayName", "Display Name", { required: false }),
    f("type", "Type", {
      showcase: true,
      kind: "enum",
      required: false,
      enumValues: ["PRODUCTION", "DEVELOPMENT", "TYPE_UNSPECIFIED"],
    }),
    f("state", "State", { showcase: true, required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsMetrics: true,
});
