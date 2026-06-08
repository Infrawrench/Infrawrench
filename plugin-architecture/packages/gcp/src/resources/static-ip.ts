import { f, o, rt } from "@infrawrench/plugin-base";

export const StaticIpResourceType = rt({
  name: "Static IP",
  id: "static-ip",
  description: "A Google Cloud reserved static external IP address",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("address", "Address", { required: false }),
    f("addressType", "Type", { required: false }),
    f("status", "Status", { required: false }),
    f("networkTier", "Network Tier", { required: false }),
    f("ipVersion", "IP Version", { required: false }),
    f("attachedVmName", "Attached VM", {
      required: false,
      description: "Name of the VM this static IP is attached to (if any)",
    }),
    f("attachedVmZone", "Attached VM Zone", {
      required: false,
      description: "Zone of the VM this static IP is attached to (if any)",
    }),
  ],
  outputs: [o("address", "IP Address")],
  supportsCreate: true,
  attachTargets: [
    {
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      // Optional: allow drop onto VMs to attach the IP
      verb: "attach",
    },
  ],
});
