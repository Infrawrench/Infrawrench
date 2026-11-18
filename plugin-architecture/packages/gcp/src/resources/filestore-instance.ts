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
  supportsMetrics: true,
  // `nfs/server/used_bytes_percent` ("Used space as a percentage of the total
  // space", 0.0 to 100.0), charted under this label:
  // https://docs.cloud.google.com/monitoring/api/metrics_gcp_d_h
  capacityMetrics: [
    { seriesLabel: "Used Space", limit: { constant: 100 }, unit: "%", label: "Storage" },
  ],
});
