import { f, o, rt } from "@infrawrench/plugin-base";

export const FilestoreInstanceResourceType = rt({
  name: "Filestore Instance",
  id: "filestore-instance",
  description: "A Google Cloud Filestore managed NFS file server",
  fields: [
    f("name", "Name"),
    f("location", "Location"),
    f("tier", "Tier", { required: false }),
    f("state", "State", { required: false }),
    f("capacityGb", "Capacity (GB)", { kind: "number", required: false }),
    f("network", "Network", { required: false }),
    f("fileShareName", "File Share Name", { required: false }),
    f("ipAddress", "IP Address", { required: false }),
  ],
  outputs: [o("ipAddress", "IP Address")],
  dependsOn: [
    { fieldKey: "network", targetTypeId: "vpc-network", targetKey: "name", label: "in network" },
  ],
  supportsCreate: true,
});
