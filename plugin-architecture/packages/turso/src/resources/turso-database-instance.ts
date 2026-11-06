import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoDatabaseInstanceResourceType = rt({
  name: "Database Instance",
  id: "turso-database-instance",
  description: "A primary or replica instance backing a Turso database",
  fields: [
    f("database", "Database", { showcase: true }),
    f("name", "Name"),
    f("uuid", "UUID", { required: false }),
    f("type", "Type", { showcase: true, required: false }),
    f("region", "Region", { showcase: true, required: false }),
    f("hostname", "Hostname", { required: false }),
  ],
  outputs: [o("hostname", "Hostname"), o("instanceName", "Instance Name")],
  dependsOn: [
    { fieldKey: "database", targetTypeId: "turso-database", label: "instance of" },
    { fieldKey: "region", targetTypeId: "turso-location", label: "in location" },
  ],
  iconKey: "server",
});
