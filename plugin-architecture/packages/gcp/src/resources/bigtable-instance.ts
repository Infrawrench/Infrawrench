import { f, o, rt } from "@infrawrench/plugin-base";

export const BigtableInstanceResourceType = rt({
  name: "Bigtable Instance",
  id: "bigtable-instance",
  description: "A Google Cloud Bigtable instance",
  fields: [
    f("name", "Name"),
    f("displayName", "Display Name", { required: false }),
    f("type", "Type", {
      kind: "enum",
      required: false,
      enumValues: ["PRODUCTION", "DEVELOPMENT", "TYPE_UNSPECIFIED"],
    }),
    f("state", "State", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
